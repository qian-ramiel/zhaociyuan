# Live2D: Separate Licensing

The application license does not cover Live2D SDK components or model assets.

| Component | Applicable notice |
| --- | --- |
| Cubism Core runtime and declarations | [Live2D Proprietary Software License](apps/desktop/renderer/src/live2d/core/LICENSE.md) |
| Cubism Web Framework | [Framework license](apps/desktop/renderer/src/live2d/framework/LICENSE.md) |
| SDK sample-derived application files | [Samples license](apps/desktop/renderer/src/live2d/SAMPLES_LICENSE.md) |
| Bundled Niziiro Mao and Hiyori Momose sample characters | [Sample-character notices and terms](resources/builtin-characters/NOTICE.md) |
| User-imported model, artwork, motions and voice | The asset owner's terms, not this project's license |

The source tree retains Core separately with its upstream notice. The
application license does not grant rights to redistribute Live2D components
or exempt a finished application from applicable Live2D release requirements.

The repository includes the original runtime subsets of the official Niziiro
Mao (PRO) and Hiyori Momose (PRO) sample models as functional example characters.
Their original ReadMe files, full official agreements and attribution are under
`resources/builtin-characters/`. These restricted assets are not relicensed under
the application license. No personal character packages are included.
For other models, obtain them from authorized sources and check their specific
terms. Download, personal use, modification, commercial use and redistribution
are different permissions.

Before publishing an executable, hosted service or commercial product, check
[SDK Release Licensing](https://www.live2d.com/en/sdk/license/) and
[Expandable Applications](https://www.live2d.com/en/sdk/license/expandable/).
Applications that import arbitrary models may fall in the latter category.
Any applicable release agreement is publisher- and application-specific.
Forks and third-party redistributions must confirm their own authorization
when required; this repository does not grant a universal exemption.

Do not remove upstream copyright headers or apply Zhaociyuan's commercial
conditions to Live2D files. Keep the licenses and notices with redistributions
as required by their original terms.
