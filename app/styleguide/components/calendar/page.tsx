'use client'

import * as React from 'react'
import { Calendar } from '@/components/ui/calendar'
import { Separator } from '@/components/ui/separator'
import type { DateRange } from 'react-day-picker'

function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="mb-6 text-2xl font-semibold text-foreground">{title}</h2>
      {children}
      <Separator className="my-12" />
    </section>
  )
}

function ComponentPreview({
  title,
  children,
  code,
}: {
  title: string
  children: React.ReactNode
  code: string
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <div className="flex flex-wrap items-start gap-4 rounded-lg border border-border bg-card p-6">
        {children}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function PropsTable({
  props,
}: {
  props: Array<{
    name: string
    type: string
    default?: string
    description: string
  }>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="py-3 pr-4 text-left font-medium">Prop</th>
            <th className="py-3 pr-4 text-left font-medium">Type</th>
            <th className="py-3 pr-4 text-left font-medium">Default</th>
            <th className="py-3 text-left font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {props.map((prop) => (
            <tr key={prop.name} className="border-b border-border">
              <td className="py-3 pr-4 font-mono text-xs text-primary">
                {prop.name}
              </td>
              <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                {prop.type}
              </td>
              <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                {prop.default ?? '-'}
              </td>
              <td className="py-3 text-muted-foreground">{prop.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SingleDateCalendar() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
    />
  )
}

function RangeCalendar() {
  const [range, setRange] = React.useState<DateRange | undefined>({
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  return (
    <Calendar
      mode="range"
      selected={range}
      onSelect={setRange}
    />
  )
}

function MultipleCalendar() {
  const [dates, setDates] = React.useState<Date[] | undefined>([
    new Date(),
    new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  ])
  return (
    <Calendar
      mode="multiple"
      selected={dates}
      onSelect={setDates}
    />
  )
}

export default function CalendarPage() {
  return (
    <div className="max-w-4xl">
      <header className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Calendar
        </h1>
        <p className="mt-2 text-lg text-muted-foreground">
          A date picker calendar component with support for single, multiple,
          and range selection.
        </p>
      </header>

      {/* What it is */}
      <Section id="overview" title="What it is">
        <div className="prose prose-gray dark:prose-invert max-w-none">
          <p className="text-muted-foreground">
            The Calendar component provides an interactive date picker built on
            top of react-day-picker. It supports single date selection, multiple
            dates, and date range selection.
          </p>
          <p className="text-muted-foreground">
            <strong>Use when:</strong> You need users to select dates for
            booking, scheduling, filtering, or any date-related input.
          </p>
        </div>
      </Section>

      {/* Sub-components */}
      <Section id="sub-components" title="Sub-components">
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">Calendar</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              The main calendar component. Wraps react-day-picker with custom
              styling and navigation buttons.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">CalendarDayButton</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Internal component for rendering individual day buttons. Exported
              for advanced customization.
            </p>
          </div>
        </div>
      </Section>

      {/* Import */}
      <Section id="import" title="Import">
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-sm">
          <code>{`import { Calendar } from '@/components/ui/calendar'`}</code>
        </pre>
      </Section>

      {/* Selection Modes */}
      <Section id="modes" title="Selection Modes">
        <div className="space-y-8">
          <ComponentPreview
            title="Single Date Selection"
            code={`const [date, setDate] = useState<Date | undefined>(new Date())

<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
/>`}
          >
            <SingleDateCalendar />
          </ComponentPreview>

          <ComponentPreview
            title="Date Range Selection"
            code={`const [range, setRange] = useState<{ from: Date; to?: Date }>({
  from: new Date(),
  to: addDays(new Date(), 7),
})

<Calendar
  mode="range"
  selected={range}
  onSelect={setRange}
/>`}
          >
            <RangeCalendar />
          </ComponentPreview>

          <ComponentPreview
            title="Multiple Date Selection"
            code={`const [dates, setDates] = useState<Date[]>([new Date()])

<Calendar
  mode="multiple"
  selected={dates}
  onSelect={setDates}
/>`}
          >
            <MultipleCalendar />
          </ComponentPreview>
        </div>
      </Section>

      {/* Props */}
      <Section id="props" title="Props">
        <PropsTable
          props={[
            {
              name: 'mode',
              type: '"single" | "multiple" | "range"',
              default: '-',
              description: 'The selection mode of the calendar.',
            },
            {
              name: 'selected',
              type: 'Date | Date[] | DateRange',
              description: 'The currently selected date(s).',
            },
            {
              name: 'onSelect',
              type: '(date) => void',
              description: 'Callback when date selection changes.',
            },
            {
              name: 'showOutsideDays',
              type: 'boolean',
              default: 'true',
              description: 'Show days from adjacent months.',
            },
            {
              name: 'captionLayout',
              type: '"label" | "dropdown" | "dropdown-months" | "dropdown-years"',
              default: '"label"',
              description: 'Layout of the month/year caption.',
            },
            {
              name: 'buttonVariant',
              type: 'ButtonVariant',
              default: '"ghost"',
              description: 'Variant for navigation buttons.',
            },
            {
              name: 'disabled',
              type: 'Matcher | Matcher[]',
              description: 'Dates that should be disabled.',
            },
            {
              name: 'locale',
              type: 'Locale',
              description: 'Locale for date formatting.',
            },
            {
              name: 'className',
              type: 'string',
              description: 'Additional CSS classes to apply.',
            },
          ]}
        />
      </Section>

      {/* Examples */}
      <Section id="examples" title="Examples">
        <div className="space-y-8">
          <ComponentPreview
            title="With Dropdown Navigation"
            code={`<Calendar
  mode="single"
  captionLayout="dropdown"
  startMonth={new Date(2020, 0)}
  endMonth={new Date(2030, 11)}
/>`}
          >
            <Calendar
              mode="single"
              captionLayout="dropdown"
              startMonth={new Date(2020, 0)}
              endMonth={new Date(2030, 11)}
            />
          </ComponentPreview>

          <ComponentPreview
            title="Two Months Display"
            code={`<Calendar
  mode="range"
  numberOfMonths={2}
/>`}
          >
            <Calendar mode="range" numberOfMonths={2} />
          </ComponentPreview>

          <ComponentPreview
            title="With Disabled Dates"
            code={`<Calendar
  mode="single"
  disabled={{ before: new Date() }}
/>`}
          >
            <Calendar mode="single" disabled={{ before: new Date() }} />
          </ComponentPreview>
        </div>
      </Section>

      {/* Notes for the AI */}
      <Section id="ai-notes" title="Notes for the AI">
        <div className="space-y-4 rounded-lg border border-border bg-muted/50 p-6">
          <div>
            <h4 className="font-medium text-foreground">Import</h4>
            <pre className="mt-2 rounded bg-muted p-2 text-xs">
              <code>{`import { Calendar } from '@/components/ui/calendar'`}</code>
            </pre>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Basic Usage</h4>
            <pre className="mt-2 rounded bg-muted p-2 text-xs">
              <code>{`const [date, setDate] = useState<Date>()

<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
/>`}</code>
            </pre>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Key Points</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                Built on{' '}
                <code className="rounded bg-muted px-1">react-day-picker</code>{' '}
                v9
              </li>
              <li>
                Three selection modes:{' '}
                <code className="rounded bg-muted px-1">single</code>,{' '}
                <code className="rounded bg-muted px-1">multiple</code>,{' '}
                <code className="rounded bg-muted px-1">range</code>
              </li>
              <li>
                Use{' '}
                <code className="rounded bg-muted px-1">numberOfMonths</code> to
                show multiple months side by side
              </li>
              <li>
                Use{' '}
                <code className="rounded bg-muted px-1">
                  captionLayout=&quot;dropdown&quot;
                </code>{' '}
                for month/year dropdowns (requires{' '}
                <code className="rounded bg-muted px-1">startMonth</code> and{' '}
                <code className="rounded bg-muted px-1">endMonth</code>)
              </li>
              <li>
                Use <code className="rounded bg-muted px-1">disabled</code> prop
                to disable specific dates or date ranges
              </li>
              <li>
                <code className="rounded bg-muted px-1">showOutsideDays</code>{' '}
                defaults to true - shows days from adjacent months
              </li>
              <li>
                Calendar uses Button component internally for navigation and day
                selection
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">
              CSS Variables / Customization
            </h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                <code className="rounded bg-muted px-1">--cell-size</code> - CSS
                variable for day cell size (default: 8 spacing units)
              </li>
              <li>
                <code className="rounded bg-muted px-1">--cell-radius</code> -
                CSS variable for day cell border radius
              </li>
              <li>
                <code className="rounded bg-muted px-1">--primary</code> for
                selected date background
              </li>
              <li>
                <code className="rounded bg-muted px-1">--muted</code> for
                range/today background
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Common Patterns</h4>
            <pre className="mt-2 rounded bg-muted p-2 text-xs">
              <code>{`// Date picker in a popover
<Popover>
  <PopoverTrigger asChild>
    <Button variant="outline">
      {date ? format(date, "PPP") : "Pick a date"}
    </Button>
  </PopoverTrigger>
  <PopoverContent>
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
    />
  </PopoverContent>
</Popover>

// Date range picker
<Calendar
  mode="range"
  selected={range}
  onSelect={setRange}
  numberOfMonths={2}
/>`}</code>
            </pre>
          </div>
        </div>
      </Section>
    </div>
  )
}
