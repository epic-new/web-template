export type NavItem = {
  title: string
  href: string
  description?: string // AI-only: when to use this component
  items?: NavItem[]
}

export const styleguideNavigation: NavItem[] = [
  {
    title: 'Foundation',
    href: '/styleguide',
    items: [
      { title: 'Colors', href: '/styleguide#colors', description: 'Semantic color tokens and palette' },
      { title: 'Typography', href: '/styleguide#typography', description: 'Font families, sizes, and text styles' },
      { title: 'Spacing & Radius', href: '/styleguide#spacing-radius', description: 'Consistent spacing and border radius values' },
      { title: 'Shadows', href: '/styleguide#shadows', description: 'Box shadow elevation levels' },
    ],
  },
  {
    title: 'Inputs & Forms',
    href: '/styleguide/components/button',
    items: [
      { title: 'Button', href: '/styleguide/components/button', description: 'Trigger actions: form submit, dialog open, navigation' },
      { title: 'Button Group', href: '/styleguide/components/button-group', description: 'Group related buttons together' },
      { title: 'Checkbox', href: '/styleguide/components/checkbox', description: 'Toggle boolean values or multiple selections' },
      { title: 'Combobox', href: '/styleguide/components/combobox', description: 'Searchable dropdown with autocomplete' },
      { title: 'Field', href: '/styleguide/components/field', description: 'Form field wrapper with label and error' },
      { title: 'Input', href: '/styleguide/components/input', description: 'Single-line text entry' },
      { title: 'Input Group', href: '/styleguide/components/input-group', description: 'Combine input with prefix/suffix elements' },
      { title: 'Input OTP', href: '/styleguide/components/input-otp', description: 'One-time password or verification code input' },
      { title: 'Label', href: '/styleguide/components/label', description: 'Form field label element' },
      { title: 'Native Select', href: '/styleguide/components/native-select', description: 'Browser-native dropdown select' },
      { title: 'Radio Group', href: '/styleguide/components/radio-group', description: 'Select one option from a set' },
      { title: 'Select', href: '/styleguide/components/select', description: 'Styled dropdown for single selection' },
      { title: 'Slider', href: '/styleguide/components/slider', description: 'Select numeric value within a range' },
      { title: 'Switch', href: '/styleguide/components/switch', description: 'Toggle between on/off states' },
      { title: 'Textarea', href: '/styleguide/components/textarea', description: 'Multi-line text entry' },
      { title: 'Toggle', href: '/styleguide/components/toggle', description: 'Pressable button with active/inactive state' },
      { title: 'Toggle Group', href: '/styleguide/components/toggle-group', description: 'Group of toggles for single/multiple selection' },
    ],
  },
  {
    title: 'Data Display',
    href: '/styleguide/components/avatar',
    items: [
      { title: 'Avatar', href: '/styleguide/components/avatar', description: 'Display user profile image or initials' },
      { title: 'Badge', href: '/styleguide/components/badge', description: 'Label for status, category, or count' },
      { title: 'Calendar', href: '/styleguide/components/calendar', description: 'Date picker calendar view' },
      { title: 'Card', href: '/styleguide/components/card', description: 'Group related content with visual separation' },
      { title: 'Carousel', href: '/styleguide/components/carousel', description: 'Horizontal scrolling content slider' },
      { title: 'Chart', href: '/styleguide/components/chart', description: 'Data visualization graphics' },
      { title: 'Empty', href: '/styleguide/components/empty', description: 'Placeholder for empty states' },
      { title: 'Item', href: '/styleguide/components/item', description: 'List item with icon and content' },
      { title: 'Kbd', href: '/styleguide/components/kbd', description: 'Display keyboard shortcut keys' },
      { title: 'Separator', href: '/styleguide/components/separator', description: 'Visual divider between content' },
      { title: 'Skeleton', href: '/styleguide/components/skeleton', description: 'Loading placeholder animation' },
      { title: 'Spinner', href: '/styleguide/components/spinner', description: 'Loading indicator animation' },
      { title: 'Table', href: '/styleguide/components/table', description: 'Display tabular data with rows and columns' },
    ],
  },
  {
    title: 'Feedback',
    href: '/styleguide/components/alert',
    items: [
      { title: 'Alert', href: '/styleguide/components/alert', description: 'Static message for info, warning, or error' },
      { title: 'Alert Dialog', href: '/styleguide/components/alert-dialog', description: 'Confirm destructive action before proceeding' },
      { title: 'Progress', href: '/styleguide/components/progress', description: 'Display completion percentage' },
      { title: 'Sonner', href: '/styleguide/components/sonner', description: 'Toast notifications for transient messages' },
      { title: 'Tooltip', href: '/styleguide/components/tooltip', description: 'Contextual info on hover or focus' },
    ],
  },
  {
    title: 'Layout',
    href: '/styleguide/components/aspect-ratio',
    items: [
      { title: 'Aspect Ratio', href: '/styleguide/components/aspect-ratio', description: 'Maintain consistent width-to-height ratio' },
      { title: 'Collapsible', href: '/styleguide/components/collapsible', description: 'Expandable/collapsible content section' },
      { title: 'Direction', href: '/styleguide/components/direction', description: 'RTL/LTR text direction provider' },
      { title: 'Resizable', href: '/styleguide/components/resizable', description: 'Adjustable panel sizes via drag' },
      { title: 'Scroll Area', href: '/styleguide/components/scroll-area', description: 'Custom scrollbar container' },
    ],
  },
  {
    title: 'Navigation',
    href: '/styleguide/components/accordion',
    items: [
      { title: 'Accordion', href: '/styleguide/components/accordion', description: 'Vertically stacked expandable sections' },
      { title: 'Breadcrumb', href: '/styleguide/components/breadcrumb', description: 'Show hierarchical page location' },
      { title: 'Command', href: '/styleguide/components/command', description: 'Command palette with search and actions' },
      { title: 'Context Menu', href: '/styleguide/components/context-menu', description: 'Right-click contextual actions menu' },
      { title: 'Dropdown Menu', href: '/styleguide/components/dropdown-menu', description: 'Click-triggered actions menu' },
      { title: 'Menubar', href: '/styleguide/components/menubar', description: 'Horizontal menu bar with dropdowns' },
      { title: 'Navigation Menu', href: '/styleguide/components/navigation-menu', description: 'Primary site navigation links' },
      { title: 'Pagination', href: '/styleguide/components/pagination', description: 'Navigate through paginated content' },
      { title: 'Sidebar', href: '/styleguide/components/sidebar', description: 'Vertical navigation panel' },
      { title: 'Tabs', href: '/styleguide/components/tabs', description: 'Switch between content panels' },
    ],
  },
  {
    title: 'Overlays',
    href: '/styleguide/components/dialog',
    items: [
      { title: 'Dialog', href: '/styleguide/components/dialog', description: 'Modal overlay requiring user attention' },
      { title: 'Drawer', href: '/styleguide/components/drawer', description: 'Slide-out panel from screen edge' },
      { title: 'Hover Card', href: '/styleguide/components/hover-card', description: 'Preview content on hover' },
      { title: 'Popover', href: '/styleguide/components/popover', description: 'Floating content anchored to trigger' },
      { title: 'Sheet', href: '/styleguide/components/sheet', description: 'Full-width slide-out panel' },
    ],
  },
]
