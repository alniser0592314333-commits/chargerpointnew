# Application Shell & Navigation Architecture (`docs/application-shell.md`)

## 1. Overview
The Application Shell (Phase 6.2) establishes the production-quality structural container for all future business pages. It cleanly separates Public and Authenticated areas, provides responsive navigation (Desktop Sidebar, Tablet Adaptive, Mobile Drawer), and implements global UX controls (Theme switch, Language switch, Admin profile menu, Sync indicator stubs, and global error/loading states).

## 2. Layout Hierarchy
- **PublicLayout**:
  - `PublicHeader`: Navigation entry points, public order checking, theme & language switches.
  - `PublicContent`: Landing page and public authentication views.
- **AuthenticatedAppLayout**:
  - `Sidebar` (Desktop) / `MobileNav` (Drawer for mobile & tablet)
  - `Header`: Mobile menu trigger, page title, breadcrumbs, sync status indicator, notifications entry, profile menu, theme & language switches.
  - `PageContent`: Standardized responsive content container with title, subtitle, and action slots.

## 3. Primary Navigation Destinations
1. **Home** (`/app`): Operational summary and placeholder metrics.
2. **Days / Orders** (`/app/days`): Structural entry for daily operations and orders.
3. **Customers** (`/app/customers`): Structural entry for customer management.
4. **Financials** (`/app/financials`): Structural entry for payments, ledger, and financials.
5. **Goals** (`/app/goals`): Structural entry for targets and bonuses.
6. **Notifications / Requests** (`/app/notifications`): Structural entry for alerts and requests.
7. **Settings** (`/app/settings`): General settings, Device Configuration, Pricing/Fees, QR Design, Admin/User Management, Sync, Updates, and About.

## 4. Security & Permissions Integration
- Navigation items dynamically respect effective permissions where relevant, while server-side authorization remains authoritative.
- Unauthenticated users are redirected to public routes.
- Unauthorized route access presents a localized Forbidden (403) state.
