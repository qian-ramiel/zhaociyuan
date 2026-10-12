# Live2D: Separate Licensing

The application license does not cover Live2D SDK components or model assets.

| Component | Applicable notice |
| --- | --- |
| Cubism Core runtime and declarations | [Live2D Proprietary Software License](apps/desktop/renderer/src/live2d/core/LICENSE.md) |
| Cubism Web Framework | [Framework license](apps/desktop/renderer/src/live2d/framework/LICENSE.md) |
| SDK sample-derived application files | [Samples license](apps/desktop/renderer/src/live2d/SAMPLES_LICENSE.md) |
| User-imported model, artwork, motions and voice | The asset owner's terms, not this project's license |

The source tree retains Core separately with its upstream notice, following the
component-separation pattern seen in Open-LLM-VTuber. This does not establish that
its redistribution or a finished application is exempt from Live2D review.

No sample-character model data or personal character packages are included in
this repository. Obtain models from their authorized source and check the
specific asset terms. Download, personal use, modification, commercial use and
redistribution are different permissions.

Before publishing an executable, hosted service or commercial product, check
[SDK Release Licensing](https://www.live2d.com/en/sdk/license/) and
[Expandable Applications](https://www.live2d.com/en/sdk/license/expandable/).
Applications that import arbitrary models may fall in the latter category.
The project does not claim a signed release agreement or a universal exemption.

Do not remove upstream copyright headers or apply Zhaociyuan's commercial
conditions to Live2D files. Keep the licenses and notices with redistributions
as required by their original terms.
