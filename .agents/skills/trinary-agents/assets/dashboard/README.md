# Dashboard runtime assets

These pinned third-party assets are embedded into generated dashboards so the
dashboard makes no runtime resource requests. The generator has no package
dependencies. Keep the adjacent license files and the notice block embedded in
each generated HTML page when distributing the assets or page.

Verified from the exact npm package metadata and license files on 2026-10-18:

| File | Package and version | Source | License |
| --- | --- | --- | --- |
| `tailwind-browser-4.3.3.js` | [`@tailwindcss/browser@4.3.3`](https://www.npmjs.com/package/@tailwindcss/browser/v/4.3.3), `dist/index.global.js` | [Tailwind CSS repository](https://github.com/tailwindlabs/tailwindcss/tree/main/packages/%40tailwindcss-browser) | MIT, full text in `LICENSE-tailwind-browser-MIT.txt` |
| `daisyui-5.7.50.css` | [`daisyui@5.7.50`](https://www.npmjs.com/package/daisyui/v/5.7.50), `daisyui.css` | [daisyUI repository](https://github.com/saadeghi/daisyui) | MIT, full text in `LICENSE-daisyui-MIT.txt` |
| `d3-7.9.0.min.js` | [`d3@7.9.0`](https://www.npmjs.com/package/d3/v/7.9.0), `dist/d3.min.js` | [D3 repository](https://github.com/d3/d3) | ISC, full text in `LICENSE-d3-ISC.txt`; related package notices are listed below |

MIT redistribution requires the copyright and permission notice in copies or
substantial portions. ISC redistribution requires its copyright and permission
notice in all copies. The exact upstream license texts are retained beside
the assets and embedded in generated dashboards as an HTML comment.

The pinned `d3` package dependency tree also declares these licenses. Their
notices are included conservatively with the bundled D3 distribution:

| Package | Version | License file | Upstream source |
| --- | --- | --- | --- |
| `d3-ease` | 3.0.1 | BSD-3-Clause, `LICENSE-d3-ease-BSD-3-Clause.txt` | [d3-ease](https://github.com/d3/d3-ease) |
| `robust-predicates` | 3.0.3 | Unlicense, `LICENSE-robust-predicates-Unlicense.txt` | [robust-predicates](https://github.com/mourner/robust-predicates) |
| `commander` | 7.2.0 | MIT, `LICENSE-commander-MIT.txt` | [commander.js](https://github.com/tj/commander.js) |
| `iconv-lite` | 0.6.3 | MIT, `LICENSE-iconv-lite-MIT.txt` | [iconv-lite](https://github.com/ashtuchkin/iconv-lite) |
| `safer-buffer` | 2.1.2 | MIT, `LICENSE-safer-buffer-MIT.txt` | [safer-buffer](https://github.com/ChALkeR/safer-buffer) |
| `rw` | 1.3.3 | BSD-3-Clause, `LICENSE-rw-BSD-3-Clause.txt` | [rw](https://github.com/mbostock/rw) |

## Pinned file checksums

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `tailwind-browser-4.3.3.js` | 282289 | `a60c785630a06196808cbe79e6f7bdb4abcc8f4421a47b56f29338fc84805e3b` |
| `daisyui-5.7.50.css` | 1142434 | `6a2cf91a0e9a7da09cf8109c45c3fae171e8967122576043f2b94da47fdf6b64` |
| `d3-7.9.0.min.js` | 279706 | `f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539` |
