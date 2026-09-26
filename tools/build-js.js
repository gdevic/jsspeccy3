/*
 * tools/build-js.js: bundle the runtime into dist/jsspeccy/ with webpack,
 * using the configurations in webpack.config.js.
 *
 * Usage (run from the project root, as `npm run build:js` does):
 *   node tools/build-js.js
 *
 * It drives webpack through its Node API, so the build needs no separate
 * webpack command-line package.
 */

import webpack from 'webpack';
import config from '../webpack.config.js';

webpack(config, (err, stats) => {
    if (err) {
        console.error(err);
        process.exitCode = 1;
        return;
    }
    console.log(stats.toString({ colors: Boolean(process.stdout.isTTY) }));
    if (stats.hasErrors()) process.exitCode = 1;
});
