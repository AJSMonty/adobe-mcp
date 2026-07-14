# adobe-mcp roadmap

## Shipped
- **Core**: multi-bridge architecture — osascript/ExtendScript (AE, PS, AI), CEP command-file panel (Premiere).
- **AE**: run_extendscript, get_state, save_frame, render_comp (Render Queue).
- **Photoshop**: run_extendscript, get_state (layer tree), save_preview, export (png/jpg/layered psd), run_action.
- **Illustrator**: run_extendscript, get_state (artboards/layers), save_preview, export (svg/png/pdf/layered ai).
- **Premiere**: run_extendscript, get_state (bins/sequences/clips), import_media, import_ae_comp (Dynamic Link), save_frame, export_sequence (.epr presets) — via mcp-bridge CEP panel.
- **Character Animator**: ch_build_puppet (rig-ready PSD via PS, full auto-rig taxonomy), ch_taxonomy.
- **Workflow**: shared asset registry (workflow_assets), layered handoffs (handoff_import_to_ae, handoff_place_in_ps), per-app script libraries (list_scripts / run_script).

## Next
1. **InDesign + Media Encoder** (osascript pattern, near-free): layout/data-merge tools; AME render matrix + watch folders.
2. **Audition** (reuse the CEP panel bridge): VO cleanup, loudness normalization.
3. **Animate** (JSFL via file-open bridge): frame animation, sprite sheets.
4. **Character Animator MIDI triggers**: virtual MIDI device to fire CH behaviors programmatically.
5. **Pipelines**: named multi-app recipes (brand promo, puppet show, deliverable matrix).
6. **3D**: Substance 3D Stager via a python bridge (Dimension has no API — file-based shim only).

## Known constraints
- macOS only (osascript). Premiere panel requires PlayerDebugMode=1 (unsigned) and the panel open.
- Character Animator & Dimension have no scripting APIs — integrate around them.
- Modal dialogs in any app block the bridge (timeout) until dismissed.
