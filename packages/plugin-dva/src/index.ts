import { IApi, utils } from 'umi';
import { basename, dirname, extname, join, relative } from 'path';
import { readFileSync } from 'fs';
import { getModels } from './getModels/getModels';
import { getUserLibDir } from './getUserLibDir';

const { Mustache, lodash, winPath } = utils;

export default (api: IApi) => {
  const { logger } = api;

  // 获取 model 目录 判断是单个文件还是多个文件
  function getModelDir() {
    // api.config 获取用户配置
    // api.config.singular 判断用户配置是否开启单数模式的目录
    return api.config.singular ? 'model' : 'models';
  }

  // 获取 models 文件路径
  function getSrcModelsPath() {
    // api.paths 获取相关路径
    // absSrcPath  src 目录绝对路径，需注意 src 目录是可选的，如果没有 src 目录，absSrcPath 等同于 cwd
    return join(api.paths.absSrcPath!, getModelDir());
  }

  // 获取依赖
  function getDvaDependency() {
    // api.pkg 当前项目的 package.json，格式为 Object。
    const { dependencies, devDependencies } = api.pkg;
    return (
      dependencies?.dva ||
      devDependencies?.dva ||
      require('../package').dependencies.dva
    );
  }

  // 配置 调取 umi 插件接口
  // describe 方法在注册阶段执行，用于描述插件或插件集的 id、key、配置信息、启用方式等。
  api.describe({
    key: 'dva',
    config: {
      // schema 用于声明配置的类型
      // joi The most powerful schema description language and data validator for JavaScript.
      // 要来校验用户配置参数的有效性
      schema(joi) {
        return joi.object({
          disableModelsReExport: joi.boolean(),
          extraModels: joi.array().items(joi.string()),
          hmr: joi.boolean(),
          immer: joi.boolean(),
          skipModelValidate: joi.boolean(),
        });
      },
    },
  });

  // 获取所有 models
  function getAllModels() {
    const srcModelsPath = getSrcModelsPath();
    const baseOpts = {
      skipModelValidate: api.config.dva?.skipModelValidate,
      extraModels: api.config.dva?.extraModels,
    };
    // 创建一个去重后的array数组副本
    return lodash.uniq([
      ...getModels({
        base: srcModelsPath,
        ...baseOpts,
      }),
      // api.paths.absPagesPath  pages 目录绝对路径
      ...getModels({
        base: api.paths.absPagesPath!,
        pattern: `**/${getModelDir()}/**/*.{ts,tsx,js,jsx}`,
        ...baseOpts,
      }),
      ...getModels({
        base: api.paths.absPagesPath!,
        pattern: `**/model.{ts,tsx,js,jsx}`,
        ...baseOpts,
      }),
    ]);
  }

  // 判断是否存在 models
  let hasModels = false;

  // onStart 初始检测一遍 在命令注册函数执行前触发
  api.onStart(() => {
    hasModels = getAllModels().length > 0;
  });

  // addDepInfo 添加依赖信息，包括 semver range 和别名信息。
  api.addDepInfo(() => {
    return {
      name: 'dva',
      range: getDvaDependency(),
    };
  });

  // 生成临时文件 触发时机在 webpack 编译之前。
  api.onGenerateFiles({
    fn() {
      const models = getAllModels();
      hasModels = models.length > 0;

      // logger 插件日志类

      logger.debug('dva models:');
      logger.debug(models);

      // 没有 models 不生成文件
      if (!hasModels) return;

      // dva.ts 读取 dva 配置模板文件
      const dvaTpl = readFileSync(join(__dirname, 'dva.tpl'), 'utf-8');
      // 根据 dva 模板文件 dva.tpl , 调用 writeTmpFile 写临时文件
      api.writeTmpFile({
        path: 'plugin-dva/dva.ts',
        // Mustache : 导出自 mustache, 无逻辑的模版语法，是 JavaScript 中的 mustache 模板系统的零依赖实现。
        content: Mustache.render(dvaTpl, {
          ExtendDvaConfig: '',
          EnhanceApp: '',
          RegisterPlugins: [
            api.config.dva?.immer &&
              `app.use(require('${winPath(require.resolve('dva-immer'))}')());`,
          ]
            .filter(Boolean)
            .join('\n'),
          RegisterModelImports: models
            .map((path, index) => {
              // lodash.upperFirst 转换字符串string的首字母为大写。
              return `import Model${lodash.upperFirst(
                // lodash.camelCase 转换字符串string为驼峰写法。
                lodash.camelCase(basename(path, extname(path))),
              )}${index} from '${path}';`;
            })
            .join('\r\n'),
          RegisterModels: models
            .map((path, index) => {
              // prettier-ignore
              return `
app.model({ namespace: '${basename(path, extname(path))}', ...Model${lodash.upperFirst(lodash.camelCase(basename(path, extname(path))))}${index} });
          `.trim();
            })
            .join('\r\n'),
          // use esm version
          // winPath, 将文件路径转换为兼容 window 的路径，用于在代码中添加 require('/xxx/xxx.js') 之类的代码。
          dvaLoadingPkgPath: winPath(
            require.resolve('dva-loading/dist/index.esm.js'),
          ),
        }),
      });

      // runtime.tsx 读取运行时模板文件
      const runtimeTpl = readFileSync(join(__dirname, 'runtime.tpl'), 'utf-8');
      api.writeTmpFile({
        path: 'plugin-dva/runtime.tsx',
        content: Mustache.render(runtimeTpl, {
          SSR: !!api.config?.ssr,
        }),
      });

      // exports.ts 读取导出文件模板
      const exportsTpl = readFileSync(join(__dirname, 'exports.tpl'), 'utf-8');
      const dvaLibPath = winPath(
        getUserLibDir({
          library: 'dva',
          pkg: api.pkg,
          cwd: api.cwd,
        }) || dirname(require.resolve('dva/package.json')),
      );
      const dvaVersion = require(join(dvaLibPath, 'package.json')).version;
      const exportMethods = dvaVersion.startsWith('2.6')
        ? ['connect', 'useDispatch', 'useStore', 'useSelector']
        : ['connect'];

      logger.debug(`dva version: ${dvaVersion}`);
      logger.debug(`exported methods:`);
      logger.debug(exportMethods);

      api.writeTmpFile({
        path: 'plugin-dva/exports.ts',
        content: Mustache.render(exportsTpl, {
          exportMethods: exportMethods.join(', '),
        }),
      });

      // typings

      const connectTpl = readFileSync(join(__dirname, 'connect.tpl'), 'utf-8');
      api.writeTmpFile({
        path: 'plugin-dva/connect.ts',
        content: Mustache.render(connectTpl, {
          dvaHeadExport: api.config.dva?.disableModelsReExport
            ? ``
            : models
                .map((path) => {
                  // prettier-ignore
                  return `export * from '${winPath(dirname(path) + "/" + basename(path, extname(path)))}';`;
                })
                .join('\r\n'),
          dvaLoadingModels: models
            .map((path) => {
              // prettier-ignore
              return `    ${basename(path, extname(path))
                } ?: boolean;`;
            })
            .join('\r\n'),
        }),
      });
    },
    // 要比 preset-built-in 靠前
    // 在内部文件生成之前执行，这样 hasModels 设的值对其他函数才有效
    stage: -1,
  });

  // 添加重新临时文件生成的监听路径。
  // src/models 下的文件变化会触发临时文件生成
  api.addTmpGenerateWatcherPaths(() => [getSrcModelsPath()]);

  // dva 优先读用户项目的依赖
  api.addProjectFirstLibraries(() => [
    { name: 'dva', path: dirname(require.resolve('dva/package.json')) },
  ]);

  // modifyBabelOpts 修改 babel 配置项。
  // Babel Plugin for HMR
  api.modifyBabelOpts((babelOpts) => {
    const hmr = api.config.dva?.hmr;

    // 判断用户是否开启热更新
    if (hmr) {
      // lodash.isPlainObject 检查 value 是否是普通对象

      const hmrOpts = lodash.isPlainObject(hmr) ? hmr : {};
      babelOpts.plugins.push([
        require.resolve('babel-plugin-dva-hmr'),
        hmrOpts,
      ]);
    }
    return babelOpts;
  });

  // Runtime Plugin
  // 添加运行时插件，返回值格式为表示文件路径的字符串。
  api.addRuntimePlugin(() =>
    hasModels ? [join(api.paths.absTmpPath!, 'plugin-dva/runtime.tsx')] : [],
  );

  // 添加运行时插件的 key，返回值格式为字符串。
  api.addRuntimePluginKey(() => (hasModels ? ['dva'] : []));

  // 添加需要 umi 额外导出的内容，导出内容
  api.addUmiExports(() =>
    hasModels
      ? [
          {
            exportAll: true,
            source: '../plugin-dva/exports',
          },
          {
            exportAll: true,
            source: '../plugin-dva/connect',
          },
        ]
      : [],
  );

  // 注册命令
  api.registerCommand({
    name: 'dva',
    fn({ args }) {
      // args 的格式同 yargs 的解析结果
      if (args._[0] === 'list' && args._[1] === 'model') {
        const models = getAllModels();
        console.log(utils.chalk.bold('  Models in your project:'));
        models.forEach((model) => {
          console.log(`    - ${relative(api.cwd, model)}`);
        });
        console.log(`  Totally ${models.length}.`);
      }
    },
  });
};
