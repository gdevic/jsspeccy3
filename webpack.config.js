import fs from 'fs';
import webpack from 'webpack';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));

export default [
    {
        output: {
            filename: 'jsspeccy/jsspeccy.js',
        },
        name: 'jsspeccy',
        entry: './runtime/jsspeccy.js',
        mode: 'production',
        module: {
            rules: [
                {
                    test: /\.svg$/,
                    loader: 'svg-inline-loader',
                }
            ],
        },
        plugins: [
            new webpack.DefinePlugin({
                __JSSPECCY_VERSION__: JSON.stringify(version),
            }),
        ],
    },
    {
        output: {
            filename: 'jsspeccy/jsspeccy-worker.js',
        },
        name: 'worker',
        entry: './runtime/worker.js',
        mode: 'production',
    },
];
