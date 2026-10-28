# Vendored SheetJS Community Edition

- Version: **0.20.3**, mini standalone browser build.
- Downloaded: 2026-10-28.
- Official script: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js
- Official license: https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE
- Integration documentation: https://docs.sheetjs.com/docs/getting-started/installation/standalone/
- License: Apache-2.0, reproduced unchanged in `SHEETJS-LICENSE.txt`.
- The script is retained unchanged and loaded locally. Import does not contact the CDN.
- The mini build supports `.xlsx`; this application does not accept legacy `.xls` files.

SHA-256:

```text
0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939  xlsx.mini.min.js
4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64  SHEETJS-LICENSE.txt
```

When updating, download the script and license from the official versioned source,
update these hashes, and run the real-workbook tests in `tests/glossary-xlsx.test.mjs`.
