# Design System & Token Architecture (`docs/design-system.md`)

## 1. Design Philosophy
- Modern, clean, calm, and highly usable "AI-era" administrative and operational interface.
- Centralized token-driven styling utilizing Tailwind CSS v4 and CSS variables.
- Full support for Light and Dark themes, as well as Arabic (RTL) and English (LTR).

## 2. Central Design Tokens
- **Colors**: Semantic tokens for background, surface, primary, secondary, destructive, success, warning, info, and focus rings.
- **Typography**: Inter / Cairo font families with responsive type scales and financial numeric hierarchy.
- **Spacing**: 4px-based consistent spacing scale.
- **Radius**: Consistent border-radius tokens (`sm`, `md`, `lg`, `xl`, `full`).
- **Elevation**: Subtle, card, elevated, and dialog shadow tokens.
- **Motion**: Fast (150ms), normal (250ms), slow (350ms) respecting reduced-motion preferences.

## 3. Core Component System
- Reusable primitives: Button, Input, Textarea, Select, Checkbox, Switch, Radio, Card, Badge, StatusBadge, Tooltip, Dropdown, Tabs, Breadcrumb, Pagination, Table, EmptyState, LoadingState, ErrorState, SuccessState, Skeleton, Toast, Alert, ConfirmationDialog, Modal, Drawer/Sheet.
