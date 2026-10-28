# Third-party dependencies

Original workbench code in this repository is MIT licensed. Dependencies keep their own licenses; the MIT notice does not relicense them.

- Optional Meta adapter: [getmcpads-com/meta-ads-mcp-server](https://github.com/getmcpads-com/meta-ads-mcp-server), Apache-2.0; pinned commit `1f2ebe6c93c2ff9c8ed4c22b4f9ff06a8f7aebd8`. Downloaded only by an explicit installation command, not included in this repository. Keep its LICENSE/NOTICE when redistributing a built bundle.
- Optional Google adapter: [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp), Apache-2.0; integration was based on commit `9a78cbdceebae71a6bc8483bdec333695834ef9c`. Not bundled; needs independent OAuth/developer-token setup and compatibility verification.
- `@modelcontextprotocol/sdk` and `pg`: exact versions and transitive dependencies are pinned in package-lock.json. Their installed license files apply.
- Node.js, PostgreSQL, Python, FFmpeg and container base images have their own licenses. They are not relicensed by this project.

The example SVG is authored for this repository. All example records are fictional. Platform names belong to their respective owners; this is an independent project without platform endorsement.
