---
name: NeonSweep
description: A clear local control room for reviewing Discord cleanup.
colors:
  canvas: "#090f14"
  sidebar: "#0c141b"
  panel: "#111c24"
  raised: "#172630"
  input: "#0d171e"
  border: "#2b3e49"
  text: "#e9f1f2"
  muted: "#a4b6bf"
  subtle: "#819aa6"
  primary: "#68e7db"
  primary-hover: "#94f2e9"
  primary-deep: "#102f31"
  acid: "#dfed83"
  danger: "#ffaba2"
typography:
  headline:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "33px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-1px"
  page-title:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.6px"
  title:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  caption:
    fontFamily: "Instrument Sans, Segoe UI, sans-serif"
    fontSize: "11px"
  activity:
    fontFamily: "Consolas, Courier New, monospace"
    fontSize: "11px"
    lineHeight: 1.75
rounded:
  badge: "4px"
  button: "5px"
  input: "6px"
  disclosure: "7px"
  choice: "8px"
  panel: "10px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "24px"
  xl: "30px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#092728"
    rounded: "{rounded.button}"
    padding: "10px 17px"
    height: "43px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "#192a35"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: "10px 17px"
    height: "43px"
  button-danger:
    backgroundColor: "#352529"
    textColor: "#ffb9af"
    rounded: "{rounded.button}"
    padding: "10px 17px"
    height: "43px"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.text}"
    rounded: "{rounded.input}"
    padding: "0 12px"
    height: "44px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  navigation-active:
    backgroundColor: "#143033"
    textColor: "#d4fcf5"
    rounded: "{rounded.choice}"
    padding: "14px 10px"
  status-connected:
    backgroundColor: "#102824"
    textColor: "#b6f4e8"
    rounded: "{rounded.button}"
    padding: "9px 11px"
---

# Design System: NeonSweep

## Overview

**Creative North Star: "The Neon Control Room"**

NeonSweep brings a cyberpunk palette to a readable desktop workspace. Blue-black surfaces, clear cyan actions, and small acid-yellow signals create its identity. The angular N mark and orbital line illustration give the product a recognizable signature. Instrument Sans, visible field labels, and generous message rows keep consequential choices easy to read.

The interface is composed around one decision at a time: a persistent numbered rail, an open setup canvas, and a dedicated running/results surface. Flat materials and precise outlines carry the structure. The product's own identity supersedes the former Redact visual reference. This document captures the implemented (5.0.0) system in `src/index.html`, `src/styles.css`, and `src/renderer.js`.

**Key Characteristics:**

- Dark ink surfaces with cyan actions and restrained acid-yellow signals.
- A readable four-step setup followed by a full-width results workspace.
- Flat bordered surfaces, modest corners, and local outline artwork.
- Progress and decisions stay visible while messages and request details scroll.

## Colors

The palette uses cool tonal separation to make controls and content legible; bright accents identify actions and meaningful state. Frontmatter values are normative.

### Primary

- **Signal cyan:** primary buttons, selected controls, matched statistics, progress, the brand mark, and small text actions. Primary buttons use dark ink text. The lighter primary variant supplies hover.
- **Deep cyan:** a dark accent foundation for related selection surfaces. Selected fills and outlines vary by component so controls remain distinct from their containers.

### Secondary

- **Acid yellow:** the brand dot, keyboard focus, local-status point, deleted statistic, and update-ready indicator. Supporting yellow-green tones draw attention to estimates and the permanent-deletion note.

### Tertiary

- **Soft coral:** destructive and stop controls, errors, and destructive text actions. Filled destructive buttons use dark rose with a defined rose border.

### Neutral

- **Midnight ink:** canvas; **rail ink:** persistent sidebar; **panel ink:** grouped surfaces.
- **Raised slate:** an upper surface tone; **input ink:** recessed controls.
- **Structural slate:** separators and panel outlines. Inputs have stronger borders than their containers.
- **Frost text:** main content; **mist slate:** helper text; **muted steel:** quieter detail. Captions retain visible contrast against their own surface.

**The Signal Rule.** Cyan identifies action and selection. Acid yellow is a small signal and focus color; it does not replace cyan across primary actions.

## Typography

**Display Font:** Instrument Sans, with Segoe UI and sans-serif fallbacks.  
**Body Font:** Instrument Sans, with the same fallbacks.  
**Label/Mono Font:** Instrument Sans for interface labels; Consolas and Courier New for activity output only.

**Character:** The locally bundled variable font supports weights (400–700). Its open forms and restrained weight changes balance the technical palette. Setup copy, messages, IDs, counters, and timing fields remain in the sans-serif family; numerical progress uses tabular numerals.

### Hierarchy

- **Headline:** the frontmatter headline role introduces a setup step. It becomes (29px) at compact desktop widths, (28px) in short windows, and (39px) on wide desktops.
- **Page title:** the topbar heading orients the current step or job state; it becomes (21px) at compact widths and (27px) on wide desktops.
- **Title:** panel labels use the title role. Results headings use (19px) normally, while the account explainer has its own larger heading.
- **Body:** ordinary form and message text uses the body role. Helper copy is generally (12–13px), with line heights around (1.5–1.75). Setup introductions are limited to (70ch), preview content to (100ch).
- **Label and caption:** visible labels use the label role. Secondary metadata, dates, content-tile labels, and compact status copy use the caption role; the current caption floor is (11px).
- **Activity:** the frontmatter activity role applies only inside the request log.

**The Readable Console Rule.** Express the technical identity through color, linework, and orderly numbers. Keep ordinary interaction and message reading in Instrument Sans.

## Layout

The supported Windows desktop minimum is (1100 × 760). Setup uses a persistent left rail and one visible step panel. The progression is **Connect → Choose conversations → Set your rules → Review & start**; internal step keys are `account`, `targets`, `rules`, and `launch`. Results and App updates are separate surfaces.

- **Rail:** (248px) by default, (214px) at widths of (1270px) or less, and (278px) at widths of (1800px) or more. Step labels stay visible throughout the supported range.
- **Setup canvas:** centered, with (42px) horizontal insets and a maximum width of (1120px). Compact insets are (28px); wide setup grows to a maximum of (1180px). Topbar and footer align with the workspace.
- **Account:** a two-column container pairs a labeled control stack with the local orbital N illustration.
- **Conversations:** pipeline selection and DM/server tabs sit above a searchable two-column target list. A selection summary follows the list; manual IDs and package import use disclosures.
- **Rules:** content types and dates occupy two columns, followed by words/mentions across the width. Content tiles use four columns. Advanced edit, thread, and moderation choices sit in a disclosure.
- **Launch:** a ruled account/conversations/rules summary precedes two mode cards. The summary names enabled advanced actions: moderator scope, entire thread deletion, reaction clearing, and edits before deletion where applicable.
- **Vertical reach:** setup scrolls as needed. Its footer is sticky so Previous/Next actions remain reachable when advanced options expand. Heights of (820px) or less tighten spacing, target-list height, content tiles, and section headings.
- **Results:** a flex column fills the workspace. Header, dashboard, selection bar, deletion footer, and activity disclosure stay outside the independently scrolling queue. Statistics sit beside progress and timing, above the queue. Wide desktops put all four statistics in one row.
- **Overflow:** conversation names truncate; message content, references, media descriptions, IDs, paths, and activity output wrap. Expanded request details have their own scroll area.
- **Secondary fallback:** below (1050px), the rail narrows to (190px), the account illustration hides, and some grids stack. This does not redefine the supported minimum.

Local review evidence under `.impeccable/review/neonsweep-v5.0.0-*` covers setup and updates at (1100 × 760) and (1440 × 960), results at (1100 × 850) and (1440 × 960), and a wide preview at (2556 × 1368). These are simulated visual review captures, not evidence of live Discord deletion.

## Elevation & Depth

The system uses **no shadows**. Blue-black tonal layering, one-pixel borders, and cyan-tinted selections create depth. Active controls are brighter and more bounded than resting containers. Sticky setup actions sit on an opaque canvas surface so scrolling content does not compete with their labels.

**The Flat Surface Rule.** Establish hierarchy through surface tone, spacing, and borders. Preserve the flat material language when adding screens.

## Shapes

Panels use the broadest frontmatter corner; choices and disclosures use intermediate corners; inputs, buttons, and badges use tighter values. Most geometry is rectangular and practical. Status dots and mode indicators are circular; the account illustration uses thin elliptical orbits and square signal points.

Icons are local inline SVG outlines, usually (20px) with rounded caps and joins. The angular N deliberately uses square caps and mitered joins. The cyberpunk identity comes from this mark and the accents without reducing legibility through clipped labels or ornamental interface chrome.

## Components

### Buttons

Compact and definite. Primary buttons use cyan with dark text, secondary buttons use slate with a visible border, quiet actions are unfilled, and destructive/stop actions use rose fill and coral text. Standard buttons have a minimum height of (43px); execution controls are more compact. Background, border, and text transitions take (160ms). Disabled controls use opacity (.45) and a default cursor.

### Inputs / Fields

Recessed and clearly labeled. Inputs and selects use the frontmatter height and shape, a stronger slate stroke, and visible labels above them. Hover strengthens the border; focus changes it to cyan and adds the shared acid outline. Tokens stay masked. Native date, select, number, and checkbox controls retain ordinary behavior. Placeholders supplement labels.

### Navigation

Numbered and persistent. Step buttons contain a bordered number, bold label, and muted explanation. Active steps use a deep cyan fill, visible border, solid cyan number, and `aria-current="step"`. Hover uses raised slate. During a job, setup navigation dims and disables. App updates sits at the rail's foot and gains an acid indicator when installation is ready.

### Status badges

Small and bounded. Connection state combines text, a dot, a border, and an accent surface when connected. Step markers and the stable-channel badge have tighter corners. Text and borders express state alongside color.

### Cards / Containers

Flat and ordered. Panels use the frontmatter panel surface, structural border, and panel corner. Typical insets are (20–25px). Mode choices use tighter corners and a clear selected fill, border, icon, and round indicator. Browser login, saved-account selection, and token entry stay together.

### Content and conversation selection

Content tiles pair a local outline icon with a caption. Checking changes fill, text, and border and adds a corner marker; keyboard focus outlines the whole tile. Conversation rows use a visible checkbox and one-line name; selected rows receive a cyan-tinted fill and border. All eight message content types remain present.

### Results, progress, and activity

The dashboard keeps scanned, matched, deleted, and skipped counts beside elapsed time, measured speed, estimated remaining time, and estimated finish. Known deletion batches display completed and remaining work. Collection and history preview can have unknown totals; these use indeterminate progress and honest text such as “Total not known yet” or “Available after collection.” Estimates follow engine progress and cooldowns.

Preview rows show conversation, local date/time, message text, available file/embed/sticker descriptions, message ID, and author context. Unchecking excludes an item from deletion. Running jobs disable selection. Completed rows are dimmed, labeled Completed, and disabled; stopping preserves pending selections. Delete checked stays below the queue. Direct deletion is chosen on launch and receives a separate confirmation before collection.

Request details are collapsed by default and open on job error. Their local monospace log stays secondary to progress and review. Empty results, no matches, running, cooldown, stopped, completed, and interrupted states use explicit text.

### App updates

Installed version, stable channel, status/detail text, optional download progress, and contextual actions form a dedicated surface. A downloaded update reveals Restart & install; installation stays disabled during a job. The unavailable state explains development and portable build limits. The user controls restarting.

### Focus and motion

Buttons, inputs, selects, and disclosures use an acid focus outline (2px) with offset (4px). Step changes focus the new heading. Disclosure chevrons rotate; state transitions stay short. Under `prefers-reduced-motion: reduce`, transitions and animations stop and scrolling is immediate.

## Do's and Don'ts

### Do:

- **Do** preserve the ink/cyan/acid identity, angular N mark, and readable sans-serif typography.
- **Do** keep setup actions reachable at the supported minimum and progress above the scrolling results queue.
- **Do** preserve labels, keyboard focus, textual status, checked states, and reduced-motion behavior.
- **Do** expose consequential advanced choices in the launch summary and enough message context to support review.
- **Do** keep styling, fonts, and icons packaged locally.

### Don't:

- **Don't** restore superseded Redact branding, the blue palette, or the historical three-panel setup.
- **Don't** use monospace for ordinary copy, captions, message IDs, or numeric progress.
- **Don't** invent a preview total, cosmetic ETA, or completion claim before the engine establishes it.
- **Don't** add unsupported subscription, scheduling, or service claims.
- **Don't** let updates force a restart during cleanup.

