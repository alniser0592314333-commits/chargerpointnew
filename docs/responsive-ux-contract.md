# Responsive UX Contract (`docs/responsive-ux-contract.md`)

## 1. Core Principles
- **One Responsive Application**: Adapts presentation to available viewport space without removing features or hiding critical actions.
- **Mandatory Viewport Targets**: Tested across 320x568, 360x800, 390x844, 412x915, 768x1024, 820x1180, 1024x768, 1280x720, 1366x768, 1440x900, 1920x1080.
- **Overflow & Clipping Protection**: No horizontal scrolling, no unreachable close buttons, modals remain closable and scrollable.
- **Safe Areas & Keyboard Awareness**: Full support for mobile viewports, dvh/svh units, and virtual keyboards.
- **RTL & LTR Support**: Automatic layout mirroring and direction handling for Arabic and English.
