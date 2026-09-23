# Mobile Bar legacy branch retirement review

Reviewed against current `main` on 2026-09-23.

## Decision

The eight legacy Mobile Bar branches should not be merged wholesale. They are 221–272 commits behind current `main` and contain older copies of the Sales CRM, QuickBooks, System Health, and workforce code. Direct merges would risk rolling back newer production work.

The reusable planning capability selected for restoration is the multi-horizon gross-profit goal system. PR #99 ports quarterly and annual targets and current-period projections onto current `main` while preserving the existing monthly target.

## Branch-by-branch disposition

### feature/mobile-bar-workforce-portal
Legacy value:
- bartender portal
- payroll reporting
- roster/pay-rate management
- assignments and timeclock support

Current replacement:
- `/bartender/`
- `/admin/payroll/`
- `/admin/mobile-bar-workforce/`
- current Netlify functions `bartender-portal.mts`, `admin-payroll.mts`, and `admin-mobile-bar-workforce.mts`

Disposition: superseded by newer production implementations. Safe to delete after PR #99 is merged.

### feature/mobile-bar-staffing-operations
Legacy value:
- Mobile Bar staffing recommendations and assignment workflow embedded in Sales CRM
- staffing calendar concepts
- bartender performance entry concepts

Current replacement:
- dedicated Mobile Bar Workforce workspace
- Master Calendar staff scheduling
- staff workload/assignment warning systems
- bartender portal and payroll

Disposition: implementation superseded. Useful concepts are represented by current dedicated systems. Safe to delete after PR #99 is merged.

### feature/mobile-profit-goals-simulator-scenarios
Legacy value:
- monthly, quarterly, annual gross-profit targets
- booking-mix simulator
- conservative/expected/aggressive forecast scenarios

Preserved:
- monthly target already existed on current `main`
- quarterly and annual targets plus horizon projections are restored in PR #99

Deferred:
- booking-mix simulator and scenario selector are intentionally not restored because they rely on fixed historical probability assumptions and older embedded planning UI. A future simulator should use current workforce capacity, event-date conflicts, and live conversion data.

Disposition: selected durable value ported; safe to delete after PR #99 is merged.

### feature/mobile-profit-planning-controls
Legacy value:
- staffing capacity controls
- blackout dates
- monthly booking caps
- planning horizon controls

Current replacement/overlap:
- dedicated Mobile Bar Workforce availability and limits
- Master Calendar scheduling
- staff workload warnings

Deferred:
- business-level booking-cap controls could be reintroduced later as a separate capacity-planning feature using the current workforce API.

Disposition: old implementation should not be merged. Requirements retained here. Safe to delete after PR #99 is merged.

### feature/mobile-profit-planning-controls-v2
A later variant of the planning-controls work with the same core capacity concepts, built on an older application state.

Disposition: superseded by current architecture and documented requirements. Safe to delete after PR #99 is merged.

### feature/mobile-profit-planning-intelligence
Legacy value:
- editable pipeline probabilities
- rolling expected-vs-actual forecasting
- segmented conversion analysis
- monthly sales-plan concepts

Deferred:
These remain potentially useful, but the legacy implementation should not be merged because it predates the current CRM lifecycle, staff assignment, QuickBooks, and System Health changes. If rebuilt, calculations should use current CRM stages and current event/workforce data.

Disposition: requirements retained here; legacy implementation safe to delete after PR #99 is merged.

### feature/mobile-profit-seasonality-scoring-staffing
Legacy value:
- seasonality-aware planning
- lead scoring
- bartender scheduling and performance analytics

Current replacement/overlap:
- current CRM lifecycle and staff assignment system
- dedicated workforce workspace
- staff scheduling and overload warnings

Deferred:
Seasonality-aware demand forecasting and lead scoring are product enhancements rather than required recovery work and should be rebuilt against current data structures.

Disposition: requirements retained here; legacy implementation safe to delete after PR #99 is merged.

### feature/mobile-profit-seasonality-scoring-staffing-v2
Most feature-rich legacy planning branch. It combined:
- multi-horizon profit goals
- availability-aware booking simulation
- editable forecast probabilities
- rolling forecast
- segmented conversion
- staffing calendar
- bartender performance analytics
- monthly sales planning

Preserved now:
- the durable multi-horizon profit-goal capability is restored by PR #99
- workforce, availability, payroll, and scheduling capabilities exist in newer dedicated systems

Deferred for future clean rebuild:
- availability-aware profit booking simulator
- editable conversion probabilities
- rolling expected-vs-actual forecast
- segmented conversion reporting
- seasonality-aware demand model
- monthly package sales-plan recommendations
- bartender pair/team-chemistry analytics

Disposition: do not merge this stale branch. Its unique product ideas are documented here so the branch can be deleted after PR #99 is merged.

## Safe retirement condition

All eight legacy branches are safe to delete when:
1. PR #99 passes build/security QA and is merged.
2. Current `main` still contains the dedicated Mobile Bar Workforce, Bartender Portal, Payroll, Master Calendar staff scheduling, and workload warning systems.
3. This review document exists on `main`, preserving deferred product requirements that were intentionally not ported.

## Future implementation rule

Any deferred planning feature should be rebuilt from current `main` rather than cherry-picked or merged from these branches. This prevents older CRM, QuickBooks, authentication, deployment, and staff-management code from being reintroduced.
