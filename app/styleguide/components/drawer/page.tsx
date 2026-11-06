'use client'

import { useState } from 'react'
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '@/components/ui/drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Minus, Plus } from 'lucide-react'

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
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-6">
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

function GoalDrawerExample() {
  const [goal, setGoal] = useState(350)

  function adjustGoal(amount: number) {
    setGoal(Math.max(200, Math.min(400, goal + amount)))
  }

  return (
    <Drawer>
      <DrawerTrigger render={<Button variant="outline" />}>Set Goal</DrawerTrigger>
      <DrawerContent>
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle>Move Goal</DrawerTitle>
            <DrawerDescription>Set your daily activity goal.</DrawerDescription>
          </DrawerHeader>
          <div className="p-4 pb-0">
            <div className="flex items-center justify-center space-x-2">
              <Button
                variant="outline"
                size="icon"
                className="size-8 shrink-0 rounded-full"
                onClick={() => adjustGoal(-10)}
                disabled={goal <= 200}
              >
                <Minus className="size-4" />
                <span className="sr-only">Decrease</span>
              </Button>
              <div className="flex-1 text-center">
                <div className="text-7xl font-bold tracking-tighter">
                  {goal}
                </div>
                <div className="text-muted-foreground text-xs uppercase">
                  Calories/day
                </div>
              </div>
              <Button
                variant="outline"
                size="icon"
                className="size-8 shrink-0 rounded-full"
                onClick={() => adjustGoal(10)}
                disabled={goal >= 400}
              >
                <Plus className="size-4" />
                <span className="sr-only">Increase</span>
              </Button>
            </div>
          </div>
          <DrawerFooter>
            <Button>Submit</Button>
            <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

export default function DrawerPage() {
  return (
    <div className="max-w-4xl">
      <header className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Drawer
        </h1>
        <p className="mt-2 text-lg text-muted-foreground">
          A touch-friendly overlay panel that slides from the edge of the screen.
        </p>
      </header>

      {/* What it is */}
      <Section id="overview" title="What it is">
        <div className="prose prose-gray dark:prose-invert max-w-none">
          <p className="text-muted-foreground">
            The Drawer component is built on top of Base UI and provides a swipe-dismissable
            panel that slides from any edge of the screen. It is optimized for touch
            interactions and mobile interfaces.
          </p>
          <p className="text-muted-foreground">
            <strong>Use when:</strong> You need a mobile-friendly overlay for actions,
            forms, or content that users can easily dismiss with a swipe gesture.
          </p>
          <p className="text-muted-foreground">
            <strong>Drawer vs Dialog:</strong> Drawer is swipe-dismissable and ideal for
            mobile touch interfaces. Dialog is a fixed modal better for desktop.
          </p>
          <p className="text-muted-foreground">
            <strong>Drawer vs Sheet:</strong> Both slide from edges, but Drawer has native
            swipe gestures and a drag handle indicator. Sheet is better for keyboard/mouse.
          </p>
        </div>
      </Section>

      {/* Sub-components */}
      <Section id="sub-components" title="Sub-components">
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">Drawer</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Root container that manages open/closed state and swipe direction.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerTrigger</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Element that opens the drawer when clicked.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerContent</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Main content container. Includes the overlay, plus a drag handle when showSwipeHandle is set.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerHeader</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Container for title and description. Centers text for top/bottom directions.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerFooter</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Container for action buttons at the bottom.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerTitle</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Accessible title for the drawer.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerDescription</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Optional description below the title.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerClose</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Element that closes the drawer when clicked.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerPortal</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Renders drawer content in a portal (used internally).
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h4 className="font-medium text-foreground">DrawerOverlay</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Backdrop overlay (used internally by DrawerContent).
            </p>
          </div>
        </div>
      </Section>

      {/* Import */}
      <Section id="import" title="Import">
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-sm">
          <code>{`import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '@/components/ui/drawer'`}</code>
        </pre>
      </Section>

      {/* Variants */}
      <Section id="variants" title="Direction Variants">
        <div className="space-y-8">
          <ComponentPreview
            title="Bottom (Default)"
            code={`<Drawer showSwipeHandle>
  <DrawerTrigger render={<Button variant="outline" />}>Bottom Drawer</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Bottom Drawer</DrawerTitle>
      <DrawerDescription>
        Slides up from the bottom edge.
      </DrawerDescription>
    </DrawerHeader>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer showSwipeHandle>
              <DrawerTrigger render={<Button variant="outline" />}>Bottom Drawer</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Bottom Drawer</DrawerTitle>
                  <DrawerDescription>
                    Slides up from the bottom edge. Has a drag handle indicator.
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  <DrawerClose render={<Button variant="outline" />}>Close</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>

          <ComponentPreview
            title="Top"
            code={`<Drawer swipeDirection="up">
  <DrawerTrigger render={<Button variant="outline" />}>Top Drawer</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Top Drawer</DrawerTitle>
      <DrawerDescription>
        Slides down from the top edge.
      </DrawerDescription>
    </DrawerHeader>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer swipeDirection="up">
              <DrawerTrigger render={<Button variant="outline" />}>Top Drawer</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Top Drawer</DrawerTitle>
                  <DrawerDescription>
                    Slides down from the top edge.
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  <DrawerClose render={<Button variant="outline" />}>Close</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>

          <ComponentPreview
            title="Left"
            code={`<Drawer swipeDirection="left">
  <DrawerTrigger render={<Button variant="outline" />}>Left Drawer</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Left Drawer</DrawerTitle>
      <DrawerDescription>
        Slides in from the left edge.
      </DrawerDescription>
    </DrawerHeader>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer swipeDirection="left">
              <DrawerTrigger render={<Button variant="outline" />}>Left Drawer</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Left Drawer</DrawerTitle>
                  <DrawerDescription>
                    Slides in from the left edge.
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  <DrawerClose render={<Button variant="outline" />}>Close</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>

          <ComponentPreview
            title="Right"
            code={`<Drawer swipeDirection="right">
  <DrawerTrigger render={<Button variant="outline" />}>Right Drawer</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Right Drawer</DrawerTitle>
      <DrawerDescription>
        Slides in from the right edge.
      </DrawerDescription>
    </DrawerHeader>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer swipeDirection="right">
              <DrawerTrigger render={<Button variant="outline" />}>Right Drawer</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Right Drawer</DrawerTitle>
                  <DrawerDescription>
                    Slides in from the right edge.
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  <DrawerClose render={<Button variant="outline" />}>Close</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>
        </div>
      </Section>

      {/* Props */}
      <Section id="props" title="Props">
        <div className="space-y-8">
          <div>
            <h3 className="mb-4 text-lg font-medium">Drawer</h3>
            <PropsTable
              props={[
                {
                  name: 'swipeDirection',
                  type: '"up" | "right" | "down" | "left"',
                  default: '"down"',
                  description: 'The direction that dismisses the drawer. It sits on that edge of the screen.',
                },
                {
                  name: 'showSwipeHandle',
                  type: 'boolean',
                  default: 'false',
                  description: 'Whether to show the drag handle.',
                },
                {
                  name: 'open',
                  type: 'boolean',
                  description: 'Controlled open state.',
                },
                {
                  name: 'onOpenChange',
                  type: '(open: boolean) => void',
                  description: 'Callback when open state changes.',
                },
                {
                  name: 'snapPoints',
                  type: 'DrawerSnapPoint[]',
                  description: 'Heights the drawer can rest at.',
                },
              ]}
            />
          </div>
          <div>
            <h3 className="mb-4 text-lg font-medium">DrawerTrigger / DrawerClose</h3>
            <PropsTable
              props={[
                {
                  name: 'render',
                  type: 'ReactElement',
                  description: 'Element to render instead of the default button.',
                },
              ]}
            />
          </div>
          <div>
            <h3 className="mb-4 text-lg font-medium">DrawerContent</h3>
            <PropsTable
              props={[
                {
                  name: 'className',
                  type: 'string',
                  description: 'Additional CSS classes.',
                },
              ]}
            />
          </div>
        </div>
      </Section>

      {/* Examples */}
      <Section id="examples" title="Examples">
        <div className="space-y-8">
          <ComponentPreview
            title="Basic Drawer"
            code={`<Drawer>
  <DrawerTrigger render={<Button />}>Open Drawer</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Drawer Title</DrawerTitle>
      <DrawerDescription>
        This is the drawer description.
      </DrawerDescription>
    </DrawerHeader>
    <DrawerFooter>
      <Button>Submit</Button>
      <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
    </DrawerFooter>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer>
              <DrawerTrigger render={<Button />}>Open Drawer</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Drawer Title</DrawerTitle>
                  <DrawerDescription>
                    This is the drawer description.
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  <Button>Submit</Button>
                  <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>

          <ComponentPreview
            title="With Form"
            code={`<Drawer>
  <DrawerTrigger render={<Button />}>Edit Profile</DrawerTrigger>
  <DrawerContent>
    <div className="mx-auto w-full max-w-sm">
      <DrawerHeader>
        <DrawerTitle>Edit Profile</DrawerTitle>
        <DrawerDescription>
          Update your profile information.
        </DrawerDescription>
      </DrawerHeader>
      <div className="p-4 space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue="John Doe" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" defaultValue="john@example.com" />
        </div>
      </div>
      <DrawerFooter>
        <Button>Save</Button>
        <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
      </DrawerFooter>
    </div>
  </DrawerContent>
</Drawer>`}
          >
            <Drawer>
              <DrawerTrigger render={<Button />}>Edit Profile</DrawerTrigger>
              <DrawerContent>
                <div className="mx-auto w-full max-w-sm">
                  <DrawerHeader>
                    <DrawerTitle>Edit Profile</DrawerTitle>
                    <DrawerDescription>
                      Update your profile information.
                    </DrawerDescription>
                  </DrawerHeader>
                  <div className="p-4 space-y-4">
                    <div className="grid gap-2">
                      <Label htmlFor="drawer-name">Name</Label>
                      <Input id="drawer-name" defaultValue="John Doe" />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="drawer-email">Email</Label>
                      <Input id="drawer-email" defaultValue="john@example.com" />
                    </div>
                  </div>
                  <DrawerFooter>
                    <Button>Save</Button>
                    <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
                  </DrawerFooter>
                </div>
              </DrawerContent>
            </Drawer>
          </ComponentPreview>

          <ComponentPreview
            title="Interactive Example"
            code={`const [goal, setGoal] = useState(350)

<Drawer>
  <DrawerTrigger render={<Button variant="outline" />}>Set Goal</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Move Goal</DrawerTitle>
      <DrawerDescription>Set your daily activity goal.</DrawerDescription>
    </DrawerHeader>
    <div className="flex items-center justify-center space-x-2">
      <Button onClick={() => setGoal(goal - 10)}>
        <Minus />
      </Button>
      <div className="text-7xl font-bold">{goal}</div>
      <Button onClick={() => setGoal(goal + 10)}>
        <Plus />
      </Button>
    </div>
    <DrawerFooter>
      <Button>Submit</Button>
      <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
    </DrawerFooter>
  </DrawerContent>
</Drawer>`}
          >
            <GoalDrawerExample />
          </ComponentPreview>
        </div>
      </Section>

      {/* Notes for the AI */}
      <Section id="ai-notes" title="Notes for the AI">
        <div className="space-y-4 rounded-lg border border-border bg-muted/50 p-6">
          <div>
            <h4 className="font-medium text-foreground">Import</h4>
            <pre className="mt-2 rounded bg-muted p-2 text-xs">
              <code>{`import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '@/components/ui/drawer'`}</code>
            </pre>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Basic Usage</h4>
            <pre className="mt-2 rounded bg-muted p-2 text-xs">
              <code>{`<Drawer>
  <DrawerTrigger render={<Button />}>Open</DrawerTrigger>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Title</DrawerTitle>
      <DrawerDescription>Description</DrawerDescription>
    </DrawerHeader>
    {/* Content here */}
    <DrawerFooter>
      <Button>Action</Button>
      <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
    </DrawerFooter>
  </DrawerContent>
</Drawer>`}</code>
            </pre>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Required Sub-components</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                <code className="rounded bg-muted px-1">Drawer</code> - Root wrapper (required)
              </li>
              <li>
                <code className="rounded bg-muted px-1">DrawerTrigger</code> - Opens the drawer (required)
              </li>
              <li>
                <code className="rounded bg-muted px-1">DrawerContent</code> - Content container (required)
              </li>
              <li>
                <code className="rounded bg-muted px-1">DrawerTitle</code> - Required for accessibility
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Key Points</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                Use <code className="rounded bg-muted px-1">render</code> prop on DrawerTrigger and DrawerClose
                to render custom elements:
                <code className="rounded bg-muted px-1 ml-1">{`<DrawerTrigger render={<Button />}>Open</DrawerTrigger>`}</code>
              </li>
              <li>
                Set direction with <code className="rounded bg-muted px-1">swipeDirection</code> prop on Drawer:
                <code className="rounded bg-muted px-1 ml-1">&quot;up&quot; | &quot;right&quot; | &quot;down&quot; | &quot;left&quot;</code>
              </li>
              <li>
                Set showSwipeHandle on Drawer to show a drag handle
              </li>
              <li>
                Header text is centered for top/bottom directions
              </li>
              <li>
                Left/right drawers have max-width of sm (24rem) on larger screens
              </li>
              <li>
                Drawer uses the <code className="rounded bg-muted px-1">@base-ui/react</code> Drawer primitive
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">When to Use Drawer vs Dialog vs Sheet</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                <strong>Drawer:</strong> Mobile-first, touch-friendly, swipe-dismissable.
                Best for mobile interfaces and action sheets.
              </li>
              <li>
                <strong>Dialog:</strong> Centered modal for focused tasks. Best for desktop
                confirmations and forms.
              </li>
              <li>
                <strong>Sheet:</strong> Slides from edge without swipe gestures. Best for
                keyboard/mouse interfaces and side panels.
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Responsive Pattern</h4>
            <p className="mt-2 text-sm text-muted-foreground">
              For responsive designs, you can show Drawer on mobile and Dialog on desktop
              using media queries or a responsive hook.
            </p>
          </div>

          <div>
            <h4 className="font-medium text-foreground">Accessibility</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>Focus is trapped within the drawer when open</li>
              <li>Escape key closes the drawer</li>
              <li>Can be dismissed by swiping in the direction it came from</li>
              <li>Always include DrawerTitle for screen readers</li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium text-foreground">CSS Variables / Customization</h4>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                <code className="rounded bg-muted px-1">--background</code> - Drawer background
              </li>
              <li>
                <code className="rounded bg-muted px-1">--muted</code> - Drag handle color
              </li>
              <li>
                Override max-height via className on DrawerContent (default 80vh for top/bottom)
              </li>
            </ul>
          </div>
        </div>
      </Section>
    </div>
  )
}
