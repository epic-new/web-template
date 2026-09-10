---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality while preserving the repository's component, Hook, query, hydration, and design-system architecture. Use when the user asks to build or style web components, pages, dashboards, React interfaces, or other web UI.
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Architecture First

Before editing UI, read `docs/DESIGN.md`, the sources it names, and the
components reference of the `execute` skill (`references/components.md`, from
`@epicnew/skills` — see `.agents/AGENTS.md`). That reference is authoritative for
file naming, Server Component prefetch/hydration, component reuse, hook-only
behavior access, state ownership, and tests. Aesthetic direction never overrides
those constraints.

- Use the project's Next.js, React, Tailwind, and shadcn/ui stack.
- Reuse the component inventory before creating a component; add new shared
  components to the styleguide.
- Components render and consume public Hooks. They never call Actions, Services,
  Models, Drizzle, or Integrations.
- TanStack Query owns server state; Jotai owns UI state only.
- Pages that render initial reads prefetch the page query and hydrate a client
  content component. Authenticated user-owned keys include actor identity.
- Use semantic tokens from `app/globals.css`; never hardcode UI colors.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

## Project Stack

This project uses **shadcn/ui** components with **Tailwind CSS**. Always use the existing color tokens defined in `app/globals.css` (e.g., `bg-primary`, `text-muted-foreground`, `border-border`). Never hardcode colors — rely on the CSS variables from the theme so components stay consistent with the design system.

Then implement working Next.js/React code that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Commit fully to a distinctive vision while keeping the implementation accessible,
maintainable, and faithful to the repository architecture.
