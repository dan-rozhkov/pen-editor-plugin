# Sideform: OpenAI plugin directory submission

Build the package: `npm run package:openai` -> `dist/sideform-openai.zip`.
Package contents (ZIP root): `plugin.json`, `mcp.json`, `skills/`, `assets/`.

## Dashboard fields

| Field | Value |
|---|---|
| Plugin name | sideform |
| Display name | Sideform |
| Short description (max 30) | Design live UI from chat |
| Long description | See `extensions["com.openai"].interface.longDescription` in `openai/plugin.json` |
| Developer name | Sideform |
| Category | Design |
| Capabilities | Read, Write, Design, Design-to-code, Comments |
| Website | https://app.sideform.pro |
| Support URL | https://app.sideform.pro/support |
| Privacy policy | https://app.sideform.pro/privacy |
| Terms of service | https://app.sideform.pro/terms |
| Brand color | #6E56CF |
| Composer icon | assets/icon.png (256x256) |
| Logo | assets/logo.png (512x512) |
| MCP server URL | https://api.sideform.pro/mcp (streamable HTTP) |
| Auth | OAuth 2.1 (CIMD / DCR); API key alternative `Authorization: Bearer sf_...` |
| Domain verification | https://api.sideform.pro/.well-known/openai-apps-challenge |
| Default prompts | "Open a Sideform canvas and design a mobile login screen"; "Design a login screen, then restyle it with a dark theme using variables"; "Design a pricing card, then implement it as a React component"; "Design a login screen, leave a comment on it, then resolve the comment" |

## Positive test cases

Sideform has no cloud documents. The canvas opened by `open_canvas` starts empty, so every case below creates what it needs inside the same chat.

### 1
- description: Open the live canvas widget and design a new screen.
- prompt: Open a Sideform canvas and design a mobile login screen with email, password and a primary button.
- tools_triggered: open_canvas, get_guidelines, get_style_guide, batch_design, get_screenshot, snapshot_layout
- expected_behavior: The canvas widget appears in the chat. The assistant creates a login frame with the requested fields and button via batch_design, then checks the result with a screenshot or layout snapshot and describes it.

### 2
- description: Restyle a design with variables.
- prompt: Open a Sideform canvas and design a mobile login screen. Then restyle it with a dark theme. Use variables for the colors.
- tools_triggered: open_canvas, batch_design, set_variables, get_variables, get_screenshot
- expected_behavior: The assistant first creates the login screen. It then defines color variables (set_variables), applies dark fills and text colors with batch_design, reads the variables back with get_variables, and confirms the change with a screenshot.

### 3
- description: Design-to-code. The design is read only; the code appears in the chat.
- prompt: Open a Sideform canvas and design a pricing card with a plan name, price, three features and a button. Then implement the card as a React component with Tailwind.
- tools_triggered: open_canvas, batch_design, get_editor_state, batch_get, snapshot_layout, get_variables, get_screenshot
- expected_behavior: The assistant creates the pricing card. It then reads structure, computed layout, tokens and a screenshot, and writes matching component code in the chat. It does not change the design after it starts the code step.

### 4
- description: Work with design comments.
- prompt: Open a Sideform canvas and design a mobile login screen. Leave a comment on the login frame that says "Check the button contrast". Then list the comments and resolve that comment.
- tools_triggered: open_canvas, batch_design, leave_comment, read_comments, resolve_comment
- expected_behavior: The assistant creates the login frame, posts the comment on it, lists the comments, resolves the thread and reports what it changed.

### 5
- description: Place a new screen next to an existing one without overlap.
- prompt: Open a Sideform canvas and design a mobile login screen. Then design a settings screen next to it, so that the two screens do not overlap.
- tools_triggered: open_canvas, batch_design, find_empty_space_on_canvas, get_screenshot
- expected_behavior: The assistant creates the login screen, asks for free canvas space with find_empty_space_on_canvas, and builds the settings screen there. The two frames do not overlap.

## Negative test cases

### 1
- description: Non-design task; the plugin must not handle it.
- prompt: Write a Python script that renames all the files in my Downloads folder by date.

### 2
- description: Editing files on the user's disk is out of scope. Sideform only reads and edits designs in the editor.
- prompt: Open the PNG at ~/Desktop/mockup.png on my computer and crop it, then save it back.

### 3
- description: Purchasing or billing actions are not supported.
- prompt: Buy the Sideform Pro subscription for my team and pay with my saved card.

## Release notes (0.1.0)

Initial release. Connect Sideform to build and edit designs from chat: open the live canvas in the conversation, create and modify frames, text, components and variables, read and answer comments, and implement existing designs as code. Sign in with OAuth or an API key.

## Checklist for the owner

- [ ] Confirm the OpenAI organization owner account and complete organization verification.
- [ ] Set `OPENAI_APPS_CHALLENGE_TOKEN` on the Render backend, redeploy, and confirm https://api.sideform.pro/.well-known/openai-apps-challenge returns exactly the token from the dashboard.
- [ ] Check that category "Design" and the capabilities (Read, Write, Design, Design-to-code, Comments) exist in the dashboard lists.
- [ ] Create the test account with email + password (no magic link, no MFA) and VERIFY its email before submitting. Sign-in requires a verified email, and reviewers cannot receive codes. Give the credentials in the dashboard. Do not add sample data: reviewers start from an empty canvas and the test cases create what they need.
- [ ] Check that sign-in works for the test account through OAuth in ChatGPT.
- [ ] Screenshots are optional but recommended: add a few of the canvas widget and a finished design.
- [ ] Record the video walkthrough: connect, open_canvas widget, create a design, edit it, design-to-code, comments.
- [ ] Review the legal pages: /privacy, /terms and /support at app.sideform.pro all load and match what the plugin does.
- [ ] Run `npm test` and `npm run package:openai`, then upload `dist/sideform-openai.zip`.
- [ ] Paste the test cases and release notes from this file into the dashboard.
