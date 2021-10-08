import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { isString } from 'narrowing';
import { Plugin } from 'vite';

function vitePluginWasmPack(crates: string[] | string): Plugin {
  const prefix = '@vite-plugin-wasm-pack@';
  const pkg = 'pkg'; // default folder of wasm-pack module
  let config_base: string;
  let config_assetsDir: string;
  const cratePaths: string[] = isString(crates) ? [crates] : crates;
  // from ../../my-crate  ->  my_crate_bg.wasm
  function wasmFilename(cratePath: string) {
    return path.basename(cratePath).replace('-', '_') + '_bg.wasm';
  }
  const wasmMap = new Map<string, string>(); // { 'my_crate_bg.wasm': '../../wasm-game/pkg/wasm_game_bg.wasm' }
  cratePaths.forEach((cratePath) => {
    const wasmFile = wasmFilename(cratePath);
    wasmMap.set(wasmFile, path.join(cratePath, pkg, wasmFile));
  });

  return {
    name: 'vite-plugin-wasm-pack',
    enforce: 'pre',
    configResolved(resolvedConfig) {
      config_base = resolvedConfig.base;
      config_assetsDir = resolvedConfig.build.assetsDir;
    },

    resolveId(id: string) {
      for (let i = 0; i < cratePaths.length; i++) {
        if (path.basename(cratePaths[i]) === id) return prefix + id;
      }
      return null;
    },

    async load(id: string) {
      if (id.indexOf(prefix) === 0) {
        id = id.replace(prefix, '');
        const modulejs = path.join(
          './node_modules',
          id,
          id.replace('-', '_') + '.js'
        );
        const code = await fs.promises.readFile(modulejs, {
          encoding: 'utf-8'
        });
        return code;
      }
    },

    async buildStart(inputOptions) {
      for await (const cratePath of cratePaths) {
        const pkgPath = path.join(cratePath, pkg);
        const crateName = path.basename(cratePath);
        if (!fs.existsSync(pkgPath)) {
          console.error(
            chalk.bold.red('Error: ') +
              `Can't find ${chalk.bold(pkgPath)}, run ${chalk.bold.red(
                `wasm-pack build ${cratePath} --target web`
              )} first`
          );
          this.error(
            `Can't find ${pkgPath}, run 'wasm-pack build ${cratePath} --target web' first`
          );
        }
        // copy pkg generated by wasm-pack to node_modules
        try {
          await fs.copy(pkgPath, path.join('node_modules', crateName));
        } catch (error) {
          this.error(`copy crates failed`);
          return;
        }
        // replace default load path with '/assets/xxx.wasm'
        const jsName = crateName.replace('-', '_') + '.js';
        const jsPath = path.join('./node_modules', crateName, jsName);
        const regex = /input = new URL\('(.+)'.+;/g;
        let code = fs.readFileSync(path.resolve(jsPath), { encoding: 'utf-8' });
        code = code.replace(regex, (match, group1) => {
          return `input = "${path.posix.join(
            config_base,
            config_assetsDir,
            group1
          )}"`;
        });
        fs.writeFileSync(jsPath, code);
      }
    },

    configureServer({ middlewares }) {
      return () => {
        // send 'root/pkg/xxx.wasm' file to user
        middlewares.use((req, res, next) => {
          if (isString(req.url)) {
            const basename = path.basename(req.url);
            res.setHeader(
              'Cache-Control',
              'no-cache, no-store, must-revalidate'
            );
            if (basename.endsWith('.wasm') && wasmMap.get(basename) != null) {
              res.writeHead(200, { 'Content-Type': 'application/wasm' });
              fs.createReadStream(wasmMap.get(basename) as string).pipe(res);
            } else {
              next();
            }
          }
        });
      };
    },

    buildEnd() {
      // copy xxx.wasm files to /assets/xxx.wasm
      cratePaths.forEach((c) => {
        const wasmFile = wasmFilename(c);
        this.emitFile({
          type: 'asset',
          fileName: `assets/${wasmFile}`,
          source: fs.readFileSync(wasmMap.get(wasmFile) as string)
        });
      });
    }
  };
}

export default vitePluginWasmPack;
