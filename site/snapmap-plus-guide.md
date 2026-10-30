---
layout: guide
title: Guide to Snapmap+
---

# Guide to Snapmap+

## What is Snapmap+

Snapmap+ is a tool that reads and writes a DOOM (2016) SnapMap file directly, instead of going through
the game's built-in editor UI. That gives you three things the stock editor can't:

- **Properties the Properties menu doesn't expose.** Every entity in DOOM's engine has far more fields
  than SnapMap's UI shows you — Snapmap+ lets you read and write all of them.
- **No editor guardrails.** Name length limits, size limits, and the fixed lists of textures/models/
  effects the Properties menu picks from aren't rules the engine enforces — they're just what the stock
  editor's UI happens to offer. Because Snapmap+ writes the map file directly instead of going through
  that UI, none of those limits apply: you can scale something past the normal max size, or set a texture
  that isn't in SnapMap's own picker at all.
- **Entities SnapMap was never built to place.** The DOOM engine contains far more object types than
  SnapMap's palette exposes. Snapmap+ can place and configure any of them.

Edits that use stock engine behavior and installed assets can travel with the
**map file itself**, including to console players. Features that supply new
runtime resources have additional requirements: **resized Grid Rooms require
Snapmap+ on the player's PC** and cannot be delivered to vanilla or console players.

![Snapmap+ full window: Entities tab open, DOOM editor visible behind it](images/snapmap-window-and-doom.png)

---

## Installing Snapmap+

### Get the pre-patch DOOM files

Snapmap+ currently targets the DOOM build from **before** the April 2024 patch — the patch changed
enough of the engine's internals that Snapmap+ needs to be rebuilt against it, and that work is ongoing
separately. Until then, you'll need to run DOOM on the previous Steam depot:

1. Press **Windows Key + R**, then enter `steam://nav/console` to open the Steam console.
2. In the Steam console, run:
   ```
   download_depot 379720 379721 2206249600939156631
   ```
3. Once it finishes, find the downloaded files under your Steam folder, typically:
   `C:\Program Files (x86)\Steam\steamapps\content\app_379720\depot_379721`
4. Copy those files into your DOOM install folder (e.g. `C:\Program Files (x86)\Steam\steamapps\common\DOOM`),
   replacing everything when prompted.

Online services (playing and publishing maps) still work on this depot. **Multiplayer/Coop matchmaking
with other players does not** while you're on it.

Running "Verify integrity of game files" in Steam will silently pull you back to the current (patched)
build — if that happens, and you still have the Snapmap+ files installed, remove them first (see below),
verify, then redo the depot-download steps above when you want to go back to editing.

### Install Snapmap+ itself

Download **`snapmap-plus.exe`** from the [Snapmap+ site](./) (or from the project's GitHub Releases page)
and **double-click it**. It finds your DOOM 2016 install automatically by looking through your Steam
libraries, asks you to confirm, and places the overlay. That's the whole install. (In the in-game
console, Snapmap+'s commands and cvars all carry the short `sh_` prefix — `sh_help` lists them.)

A few practical notes:

- **Close DOOM first.** A running game locks the files — the installer detects this and asks you to
  close it rather than failing cryptically.
- If auto-detection can't find DOOM (a non-Steam copy, say), run it from a terminal instead and point
  it at the folder: `snapmap-plus install --doom "C:\path\to\DOOM"`.
- While Snapmap+ is in **beta**, the installer says "No stable release has been published yet" and
  installs the newest beta automatically — nothing extra to do.
- **Already installed?** Double-clicking `snapmap-plus.exe` again shows your installed version, tells you
  when a newer one is available (press Enter to update), and takes any command — `update`, `changelog`,
  `uninstall`, `status` — right there, no terminal needed.
- **Updating later:** run `snapmap-plus update` — it updates both the overlay and `snapmap-plus.exe`
  itself. You never need to re-download anything from the site.
- **Coming from the original SnapHak?** If your DOOM folder still has the original (closed-source)
  SnapHak in it, the installer notices, tells you, and removes its files as part of the install —
  Snapmap+ fully replaces it, so nothing of the old tool needs to stay behind. Your maps, prefabs and
  strings carry straight over: they are copied from the old `%USERPROFILE%\snaphak` folder into
  Snapmap+'s own data folder (`%LOCALAPPDATA%\snapmap-plus`). An old `overrides` folder is left where
  it is (see [Packages](#packages)).
- **Packages from an earlier release?** This release does not use them; see [Packages](#packages).
- **Uninstalling:** `snapmap-plus uninstall` restores your DOOM folder to exactly what it was before.
  Your own Snapmap+ data (`config.json`, prefabs, rawmaps under `%LOCALAPPDATA%\snapmap-plus`) is left
  untouched.
- `snapmap-plus help` in a terminal lists everything else: `status`, `changelog`, `version`.
  `status` and `version` also print your game's identity (`Game: DOOMx64vk.exe: DOOM 2016 build
  13954591 (20240321-104810-ginger-fuchsia, Vulkan, 3d8b4393)`), the same line the app puts on reports.

Snapmap+ supports the current DOOM 2016 on Steam (the April 2024 update). The installer checks
which build you have before downloading anything; if your game is the older 2018 build, it installs
v0.2.1-beta.19, the final Snapmap+ release for that build.

What actually lands in your DOOM folder is small: `XINPUT1_4.dll` in the folder itself (`XINPUT1_3.dll`
on the 2018 build), and
`snapmap-plus-ui.dll` inside a `snapmap-plus\` subfolder. Everything is hash-verified before a single
file is touched, and the installer keeps a record so uninstall reverses exactly what it placed. Your
settings are separate: Snapmap+ creates `%LOCALAPPDATA%\snapmap-plus\config.json` the first time it
starts, rather than shipping one in the installer.

---

## Opening Snapmap+

**Either renderer works — you don't have to pick one.** DOOM 2016 ships two executables built from the
same source, `DOOMx64vk.exe` (Vulkan) and `DOOMx64.exe` (OpenGL), and switches between them by relaunching
itself, so one Steam launch can land you in either. Snapmap+ installs once and loads into whichever
executable is actually running. Nothing to configure.

The renderer lives in the `r_renderAPI` cvar (`0` is OpenGL, `1` is Vulkan), stored in
`%USERPROFILE%\Saved Games\id Software\DOOM\base\DOOMConfig.local`. Changing it is what makes DOOM restart
into the other executable — useful to know if you're chasing a graphics problem, but not something Snapmap+
asks you to touch. OpenGL support is new: it is proven against the shipped OpenGL executable in our tests,
so if you see Snapmap+ behave differently there than under Vulkan, that's worth reporting.

Once installed, open a SnapMap in editor mode. A second window — the Snapmap+ panel — will appear
alongside the DOOM window; you'll need to switch windows (Alt+Tab) to see it, since it doesn't overlay
the game.

**Set DOOM's display mode to Windowed or Borderless while you're editing with Snapmap+ — avoid true
Fullscreen.** Snapmap+'s panel is a separate OS window, and switching away from a truly-fullscreen DOOM
window to look at it can crash the game. Borderless and Windowed don't have that problem.

### The window

Snapmap+'s panel has five tabs — **Assets**, **Entities**, **Prefabs**, **Timelines**, and **Mods** — and a couple
of controls that stay visible no matter which tab you're on:

![Snapmap+ full window: title bar, tabs, Camera Origin, View menu](images/window-tour-dark.png)

**View → Light Theme / Dark Theme** switches the panel's whole color scheme. It doesn't follow your
system theme automatically — pick whichever you prefer. Snapmap+ remembers the choice and applies it
before the window first appears on later launches, so a saved dark theme does not flash light while
loading.

`config.json` is safe to leave alone. If you deliberately delete it, Snapmap+ treats that as **Reset
preferences** and recreates the default light setting, Show Hidden off and Entity selection mode off on the
next startup. If the file is damaged, Snapmap+ keeps a timestamped `.corrupt.json` backup, restores defaults,
and tells you once. If it cannot save a window setting, that setting still works for the current session and
the window explains that it was not remembered. Updates, uninstall, and reinstall preserve the file.

The **status bar** along the bottom stays visible on every tab too:

![Status bar: connection dot and version, Selected count, X/Y/Z camera fields, Lock position, Updated stamp, help icon](images/status-bar-dark.png)

- The green dot plus version string on the left confirms Snapmap+ is connected and tells you which
  build you're running.
- **Selected** shows how many entities are currently selected.
- **X / Y / Z** is your editor camera's live position, and updates continuously while you move around —
  handy for finding coordinates to paste into a property. Check **Lock position** to pin the fields (and
  the camera) in place instead of tracking your movement live; editing a locked field's value moves the
  camera there.
- **Updated** (far right) is a live timestamp of the last change Snapmap+ picked up from the map.
- The **?** icon next to it opens the feedback dialog — see [Reporting Bugs and Requesting
  Features](#reporting-bugs-and-requesting-features).

---

## The Entities Tab

![Entities tab: list populated, one row selected](images/entities-tab-dark.png)

The Entities tab lists every entity placed in your map, by its **reference ID** and, if you've given it
one, its display name. The list keeps itself up to date automatically as you edit — **Refresh** is there
if you ever want to force an immediate re-sync yourself.

- **Filter entities...** narrows the list by typing part of an ID or name.
- **Show hidden** reveals the entities that exist in every map by default (the built-in filters like "any
  player" / "any AI", etc.) — left unchecked, those are hidden so the list stays focused on what you
  actually placed. Snapmap+ remembers the choice.
- **Follow selection** makes the list track whatever you have selected in the SnapMap 3D editor — select
  something in-game, and its row (and the Entity State panel) update to match. Turn it off if you'd
  rather browse the list independently of what's selected in-game.
- **Select in 3D** — the reverse direction: selecting a row (or rows) here also selects the matching
  entity in the SnapMap 3D editor.
- **Browse assets...** opens the [Assets tab](#the-assets-tab) as a modal, scoped to whichever entity is
  currently selected — a shortcut for retexturing or reassigning a model/sound without switching tabs.

Follow Selection and Select in 3D are opposite directions of one mode, so they cannot be enabled together.
Snapmap+ remembers the direction you choose (or that both are off) for the next launch.

- **Deselect** clears whatever's selected in the 3D editor. Occasionally clicking off an object in-game
  doesn't fully deselect it — this button is a reliable way to force it.

Right-clicking one or more selected rows gives you:

- **Copy ID** — copies the reference ID(s) to your clipboard, for pasting into another entity's property
  (e.g. a `targets` list — see [Targets and Logic Signaling](#targets-and-logic-signaling)).
- **Delete** — deletes the entity(ies) exactly as pressing Delete in the 3D editor would, following
  the same rules: objects the editor protects and room doors or caps are not deleted, and Ctrl+Z
  undoes it like any other delete. A message says what was deleted, or why nothing was.
- **Push to stack 0** — adds the entity(ies) to SnapStack's scratch stack 0 (see
  [SnapStack](#snapstack-bulk-editing)).
- **Clear stack 0** — empties stack 0 out, regardless of what's currently selected.

**Fly to entity:** select one entity and press the crosshair button beside **Revert**, or right-click
the row and choose **Fly to entity**. Snapmap+ switches the editor to Object mode if you are in
Blueprint and moves the camera in front of the entity with the cursor resting on it, so you can grab it
or open its properties right away. The camera drops to the floor beneath you as it does after Tab; if
you had **Lock position** on, it is released first.

Entities that ship as part of the map's module (rather than ones you placed yourself) also show up in
this list — editing or deleting those isn't permanent; they reset the next time the map reloads. If you
need one gone for good, deleting it directly won't stick — instead, signal it (via a `targets` list, or a
Timeline) to a Remove node/command.

---

## The Entity State Panel

Selecting an entity (in the list, or in-game with Follow Selection on) opens its **Entity State** panel
on the right.

![Entity State panel with an entity loaded](images/entity-state-panel-dark.png)

- **ID** — the entity's reference ID, read-only, with a **Copy** button.
- **Inherit** and **Classname** — together, these determine what *kind* of entity this is (see
  [Reclassing an Entity](#reclassing-an-entity)). Each has a dropdown of known values, but you can also
  type a value that isn't listed.
- **Displayname** — the name shown in the SnapMap editor and in the Entities list (not shown to players
  in-game). Editing it here bypasses the editor's character limit, and works even on entities the stock
  editor won't let you rename (filters, for instance).
- **Decl Text** — the entity's full underlying declaration, in the format described in
  [Understanding the Decl Format](#understanding-the-decl-format). This is the same data the Properties
  menu edits a slice of — here you see and can edit all of it. Syntax is colorized as you type, and
  anything the checker flags (an unknown property, a value that doesn't look like the type it expects, an
  enum value outside the known set) shows up as an underline plus a count in the corner — **hover a
  warning to jump to it**. A count of "no problems" doesn't guarantee the map will load — the checker
  catches likely mistakes, it doesn't validate everything the engine does.
- **Focus mode** (the expand icon next to the problem count) — expands the decl editor to fill the
  window, hiding the fields above and below it, for distraction-free editing of a long decl. Save,
  Revert, and the problem count stay right there next to the toggle; press **Esc** or click the icon
  again to leave.
- **Save to Decl** — commits your edits (**Ctrl+S** works as a shortcut while the decl editor has focus).
  Most visual changes won't appear in the 3D editor until you reload the map (copy-pasting the entity, or
  playing the map, will reflect the change immediately even without a reload). **You still need to save
  the map itself from SnapMap's own menu** — Save to Decl only writes the change into the in-memory map
  the editor is holding.
- **Revert** — discards your unsaved edits, reloading the entity's last-saved state.
- **Inherit / Class Descriptions** (collapsible, below the editor) — a short description of what the
  current inherit and classname actually are, when Snapmap+ has one on file.

![Focus mode active: decl editor filling the window](images/focus-mode-dark.png)

---

## Understanding the Decl Format

The Decl Text editor uses the same syntax the engine itself uses to store entities, so it's worth
learning the shape of it before you start editing.

A property is written as `propertyName = value;` on its own line — the semicolon matters; a missing one
can produce an error when the map loads. A value that's text (a file path, an entity ID) needs quotes:

```
propertyName = "some/file/path";
```

Many properties are themselves a nested group of sub-properties, wrapped in braces:

```
scale = {
    x = 64;
    y = 64;
    z = 64;
}
```

Nesting can go arbitrarily deep — indentation is optional, but keeping it consistent makes it much
easier to keep track of which brace closes which. If your braces don't balance (a `{` with no matching
`}`, or vice versa), the map will fail to load. Everything for the entity needs to sit inside the
outermost `edit { ... }` block. If you accidentally duplicate a property, only the last copy of it
survives a save.

Some properties are **lists**, using a slightly different shape:

```
renderModels = {
    num = 3;
    item[0] = "models/mapobjects/snapmaps/box_trigger.lwo";
    item[1] = "models/mapobjects/snapmaps/dynamic_block_solid.lwo";
    item[2] = "models/mapobjects/snapmaps/dynamic_block_textured.lwo";
}
```

`item[N]` entries are the list's contents, numbered from 0; `num` is the count. **Keep `num` accurate** —
too low, and Save to Decl will silently drop the out-of-range items; too high, and the game can crash
when you try to play the map. You can freely add or remove items as long as you keep `num` matching.

A couple of things to keep in mind while editing:

- Most visual changes won't show up in the 3D editor until you reload the map, copy-paste the entity,
  or play the map — the underlying data is correct immediately, the editor's live view just doesn't
  refresh itself.
- Custom materials specifically don't preview in the editor at all except on Blocking Volumes — you'll
  need to play the map to see how one actually looks, or temporarily apply it to a Blocking Volume if
  you want an in-editor preview.

---

## Common Properties

A handful of properties come up constantly:

**model** (inside `renderModelInfo`) sets what an entity looks like, referencing a model file path.
Works on any entity.

```
renderModelInfo = {
    model = "zion/characters/monsters/lostsoul/base/lostsoul.md6";
}
```

**scale** is a size multiplier on the model — `2` doubles it, decimals between 0 and 1 shrink it, and a
negative value on one axis flips the model. This goes further than the in-game Size field for Blocking
Volumes: you're not limited to whole numbers or the in-game max size.

**customMaterial** re-textures the entire model with the material specified:

```
renderModelInfo = {
    model = "models/snapmaps/props/hell/monster_skull_01.lwo";
    customMaterial = "textures/snapmaps/hotspots/ind_panels_steel";
}
```

There are many more properties beyond these — most Snapmap+ users end up picking them up from community
references and experimentation, since there isn't a single authoritative list.

---

## The Assets Tab

The Assets tab is a searchable browser over **everything DOOM's own shipped files contain** — every
material, model, sound, light, particle and more — with a live preview and one click to put what you
found onto your map. Nothing here is a bundled list Snapmap+ ships: the catalog is built by reading your
own installed game files the first time you open each category, so it's always exactly what your copy of
DOOM has.

![Assets tab: type rail on the left, catalog in the middle, preview and apply panel on the right](images/assets-browser-overview-dark.png)

The tab is three columns:

![Asset Type rail: Pinned, then Placeable and Reference categories with counts](images/asset-browser-types-dark.png)

**Asset Type** (left) — pick a category. **Placeable** categories are things you can actually put on the
map:

| Category | What it holds |
|---|---|
| **Pinned** | Your own shortlist — star any asset from its row to add it here, regardless of type. Handy for the handful of things you're using right now. |
| Materials | Surfaces/textures. A **Cross Platform Textures Only** filter narrows this down to the ones confirmed to look the same on PC, Xbox, and PlayStation. |
| Models | Props. |
| Modules | Whole pre-built SnapMap rooms — placing one drops a single entity that's both visible and solid. |
| Brush models | The individual wall/floor/detail pieces those rooms are built from. |
| Clip models | Collision shapes, placeable on their own. |
| Sounds | Filed by soundbank rather than by name — most raw sound names are near-identical, so the bank is the only grouping that actually helps. |
| Lights | The light material — the pattern a light shines through. Point vs. spot is chosen separately, from **Create as** (see below). |
| FX, Particles | The remaining placeable effect types. |

**Reference** categories (Editor defs, Entity defs, Images, Decal atlases, Perks, SWF/Flash) are look-up
only — useful for finding a name to type in by hand, but nothing to click-apply, since there's no single
right way to wire something like a Perk or a `.swf` screen into an entity.

![Catalog pane: a folder tree of everything under a category, with per-folder counts](images/assets-browser-catalog-dark.png)

**Catalog** (middle) — browse a category's folder tree, or type into **Filter every folder...** to search
across all of it at once. Folders show how many assets are inside; click through, or search, until you
land on the thing you want.

![Asset panel: preview image, name, path, and Apply to selection controls](images/asset-properties-preview-dark.png)

**Asset** (right) — once you pick something, its actual preview shows here: materials and images render
as real pixels (decoded straight from the game's own texture data, not a stand-in icon), and sounds get a
play/stop button so you can listen before committing. Below the preview:

- **Copy** — copies the asset's path, for pasting into a decl by hand.
- **Apply to selection** — writes the asset onto whichever entity you currently have selected, immediately.
  What it writes (and which entities will accept it) depends on the asset type: a material sets
  `customMaterial`, a model sets `renderModelInfo.model`, a sound sets `sound` on a speaker, and so on. If
  the selected entity's class can't use that kind of asset, Snapmap+ tells you why instead of quietly
  doing nothing.
- **New entity** — instead of applying to a selection, stages a fresh one-entity prefab holding the asset,
  picked up and ready to place exactly like Ctrl+V.
- A material specifically offers **Custom Material** (applies it by name) or **Virtual Mapping** (applies
  it as a rectangle of the shared megatexture instead of by name — the way to reach materials that have no
  name of their own) — plus a **Tile every** size and a **Bloom mask** strength.

**Reaching it from an entity you already have selected:** click **Browse assets...** on the [Entities
tab](#the-entities-tab) to open the same browser shown above as a modal, scoped to that entity — apply an
asset straight to it without leaving the Entity State panel.

![The Browse assets modal opened from the Entities tab, scoped to the selected entity](images/assets-modal-dark.png)

---

## Reclassing an Entity

Every entity has an **inherit** and a **classname**. Changing either — or both — turns one type of
entity into another.

**classname** determines the entity's actual type in the engine, and what properties are meaningful for
it. **inherit** determines what default values it starts from, and how the entity behaves while you're
still in the editor. The two have to agree with each other — a classname/inherit mismatch is a reliable
way to crash the map.

**Props are the safest thing to reclass.** They have no placement or rotation restrictions, and they
don't carry hidden properties left over from a different entity type that could conflict with the type
you're converting to.

```
Inherit:   snapmaps/volume/blocking
Classname: idVolume_Blocking
```

A worked example — turning a prop into a Mover (a scriptable-movement entity):

1. Change **Classname** to `idMover`
2. Change **Inherit** to `snapmaps/func/snap_lift`
3. Save to Decl
4. Save the map and exit the editor
5. Re-open the map

Change both fields, then save — changing one and saving before the other is exactly the mismatch that
crashes the map.

---

## The Custom Palette Tab

Some entities exist in the DOOM engine but have no resource file made for SnapMap, so there's nothing to
put in **inherit** for them. Snapmap+ handles this with a generic `snapmaps/unknown` inherit that's
compatible with any classname — no mismatch risk, regardless of what type you're setting up.

Rather than making you build one of these by hand every time, Snapmap+ seeds ready-to-place starting
points — **Unknown**, **Timeline**, and **Lift** — directly into DOOM's own Create menu, under a
**"*Custom"** tab. They are built into Snapmap+ and served from memory; nothing is written to your data
folder.

![DOOM's Create menu with the *Custom tab open, placing a Timeline entity](images/custom-palette-tab.jpg)

Drop either one in like any other object, then reclass it from there (see
[Reclassing an Entity](#reclassing-an-entity)) if you want a specific engine type rather than a bare
Unknown. If no model is set, an Unknown entity shows as a wireframe box in the editor — that box never
appears in the actual game, it's an editor-only placeholder.

Steps to reclass one manually, if you're not starting from the *Custom tab:

1. Change **Classname** to the type you want.
2. Change **Inherit** to `snapmaps/unknown`.
3. Save to Decl — only after **both** fields are changed, not one at a time, or the map will likely
   crash from the momentary mismatch.
4. Save the map, exit, and re-open it (or copy-paste the entity and delete the original).

---

## Targets and Logic Signaling

Every entity in the engine can have a `targets` list — this is a lower-level version of the signal
system SnapMap's own logic nodes are built on top of. Adding an entity to another's `targets` list has
the same effect as drawing a SnapMap logic line between them:

```
targets = {
    item[0] = "1_ind_totally_blank_room_4x/snapmaps/unknown_3923";
    num = 1;
}
```

What happens when the signal arrives depends on what's receiving it. Signaling an FX or a light directly
toggles it on/off. Entities with a classname starting `idTarget_` do something more specific when
signaled — `idTarget_Damage` deals custom damage to everything in its own `targets` list,
`idTarget_DummyFire` fires a projectile at them, and so on; think of these as the engine-level version of
SnapMap logic Inputs like "Spawn Object" or "Start Timer".

Because `targets` and SnapMap's own logic system both drive the same underlying signal, you can mix
them: add a `targets` list to a SnapMap logic **output** (On Spawned, On Entered, On Used...) or a
**filter** (Player Filter, Boolean Filter...), and firing that output/filter also signals whatever's in
the list — letting your normal SnapMap logic reach entities that aren't SnapMap logic nodes at all.

**`sh_target_any`** (a DOOM console command — press **~** to open the console) is a second way to wire
this up, without touching decl text at all.
While it's toggled on, entities that would normally need a `targets` list become valid endpoints for the
native wire tool — so you can drag a wire from a logic node straight to one, the same way you'd wire two
ordinary SnapMap logic nodes together, instead of typing an ID into a `targets` list by hand. Run
`sh_target_any` again to turn it back off and return to normal SnapMap logic wiring.

![sh_target_any active: the wire from 'On Map Started' to the Timeline entity turns green while revealed](images/sh-target-any.jpg)

---

A lot more becomes possible once you're editing raw decls directly -- turning entities into Movers
(scripted movement/rotation), universal entity spawners, Particle Emitters, custom-animated models, and
binding entities together so they move as one. That's engine-level territory rather than a Snapmap+ UI
feature as such, so it's covered separately rather than here.

---

## The Timelines Tab

A **Timeline** is a single entity that can run multiple scripted actions, on multiple other entities, at
the same or staggered times. Timelines are painful to set up by hand in the raw decl text, so Snapmap+
gives them a dedicated editor.

![Timelines tab: list on the left, an open Timeline with eventcalls on the right](images/timelines-tab-dark.png)

**Getting a Timeline into your map:** press **+** (Create New Timeline) at the top of the list while
you are in Object mode. Snapmap+ stages a fresh Timeline for the editor's paste: click in the 3D view to
drop it where you like, and it appears in the list, already selected and open. You can still place one
from the **\*Custom** palette tab (see [The Custom Palette Tab](#the-custom-palette-tab)) if you prefer.
It's worth giving each Timeline a unique **Displayname** so you can tell them apart in the list.

**Folders:** the list groups Timelines by the part of their name before the first slash, so a Timeline
called `Arena/Wave 1` sits in an **Arena** folder (and shows that way in the in-game logic view too). Press
**New Folder** to start one, then drag Timelines into it; drag them back onto the blank space below the
list to take them out, or right-click a Timeline for **Move to** choices. Shift-click and Ctrl-click
select several at once. Renaming a folder renames the Timelines inside it; deleting one moves them back
out. Folders start closed and remember which ones you leave open. Because a folder is just a naming
convention, it travels with the map and with anyone you share it with.

Once a Timeline is placed, it shows up here automatically — click it in the list to open it in the
editor on the right.

A Timeline is organized into **entity events** and **eventcalls**. For every entity you want to script,
you add one entity-event tab; under that tab, you add one eventcall per script you want to run on that
entity.

- The **+** tab adds a new entity-event tab, labeled **Item N** (matching the underlying decl's own
  `item[N]` numbering).
- **Runs on** picks which entity that tab's eventcalls apply to — type an ID, pick from the dropdown, or
  select the entity in the SnapMap editor and click **Use current selection** (exactly one entity must be
  selected for that to work).
- **Add Eventcall** appends a new, blank script call under the current tab.
- Each eventcall has a **Time** (milliseconds of delay between the Timeline firing and this eventcall
  running — can be left blank) and an event/script name — type to search, or pick from the dropdown. Once
  a script is picked, its specific parameters appear below it as proper typed fields (a checkbox for a
  boolean, a coordinate row for a vector, a constrained dropdown for a decl/enum reference) — unlike Time,
  every one of these needs a value, or you'll hit errors.
- **What does this event do?** (collapsible, under a configured eventcall) gives a short explanation of
  the selected script, when one's on file.
- **Save Timeline** commits your edits to the Timeline entity. As with any other entity, **you still need
  to save the map itself** from SnapMap's own menu afterward. **Revert** discards local edits and re-reads
  the Timeline as it currently exists on the map.

A Timeline isn't a native SnapMap logic node, so signaling it only works through
[Targets](#targets-and-logic-signaling) — either by adding its ID to another entity's `targets` list
directly, or by turning on `sh_target_any` and wiring it up with the native wire tool.

---

## The Prefabs Tab

![Prefabs tab: folder tree on the left, a selected prefab's interactive 3D preview and details on the right](images/prefabs-tab-dark.png)

The Prefabs tab saves a group of entities so you can reuse it later, or share it with someone else
running Snapmap+.

**Creating one:** select the entities in the SnapMap editor, then click **Create from selection**. Give
it a name, and it's added to the list. **Your cursor must be hovering one of the selected objects when
you do this** — whichever object that is becomes the one centered on your cursor when you later paste
the prefab back in. SnapMap anchors the prefab on the line through the **centre of your view**, not on
the cursor. If that line misses the hovered object, Snapmap+ anchors the prefab on the hovered object
itself instead and says **grab point corrected** when it saves. Without this the saved positions could
come out scrambled. When you paste, the prefab appears in front of the camera, turned by however much
your heading has changed since you created it.

**Using one:** select a prefab in the list to see its details on the right — its name, description, and
tags, plus an **interactive 3D preview** of what you're about to place: drag to orbit, scroll to zoom,
double-click to frame it. The preview colors entities by what they do — solid, blocking, AI Navigation,
interactable, logic/I/O, triggers — so you can tell what a prefab actually contains before you drop it in.
It shows the prefab level and upright, the way it pastes, even when it was created while hovering a tilted
ramp. Blocking Boxes ticked for **AI Navigation** are tinted green, and their number appears beside the
entity count. Click **Load / Place** to stage the prefab for placement with SnapMap's built-in paste
function, then switch to the editor and press **Ctrl+V** to actually drop it into the map. When the
placed prefab brings in AI Navigation boxes, Snapmap+ updates the navmesh by itself once you drop
it, just as **View > Update Navmesh** would.

**Blueprint prefabs:** a prefab can also be whole rooms. In Blueprint mode, select one or more modules
and click **Create from selection**: the modules are saved together with every object inside them, their
door and cap slots, the wires and references that stay inside the set, and the map variables those
objects use (a wire that leaves the set is dropped and counted in the details). These prefabs carry a
**Blueprint** badge in the list, and the details pane shows a top-down footprint of the modules with the
first module marked as the anchor, plus the module, object and door counts. **Place in Blueprint** is
only enabled in Blueprint mode: the rooms appear under your cursor already grabbed, like SnapMap's own
Duplicate, so move them, rotate with **Q** and **E**, press **Space** to drop them (one undo step) or
**Esc** to discard them. A placement that would push the map over the editor's limits is refused and
taken back.

**Organizing:** **New Folder** creates a folder you can drag prefabs into; **Filter prefabs...** narrows
the list by name or tag. Folders start closed, and the ones you open stay open when you switch tabs or
restart the game; a filter shows every folder that has a match. **Shift-click** selects a run of rows and
**Ctrl-click** adds or removes one (folders too). With more than one prefab selected the details pane
steps aside: drag the set onto a folder, or onto the blank space below the list to move it back to the
root, and it moves in one go. Dragging a folder onto another folder moves its prefabs across. Selecting a
prefab and clicking **Delete** removes it permanently; with several selected, the **Delete** key or the
right-click menu removes them all after one confirmation.

Prefabs are stored as individual files under `%LOCALAPPDATA%\snapmap-plus\prefabs\` — sharing one is just
sending someone that file; they drop it into their own `prefabs` folder (or the matching subfolder, to
land it in the same folder on their end) and it shows up in their list. You can drop a file into that
folder from Windows while Snapmap+ is already running — no restart needed, it picks the new prefab up
right away.

---

## Rawmaps

A **rawmap** is a human-readable JSON copy of a map. Use one to share a map
without publishing it, keep backups, or edit its contents in a text editor.
The default file is `%LOCALAPPDATA%\snapmap-plus\rawmap.json`.

All rawmap actions are in the **File** menu:

| Menu option | What it does |
|---|---|
| **Load Rawmap...** | Pick a rawmap file. Snapmap+ asks if you want to open it now. **OK** opens it as a new map and discards unsaved edits in the editor. **Cancel** keeps the file waiting, so you can save your work first. |
| **Save Rawmap** | Write the map you are editing to the **Save Path**, including unsaved edits. |
| **Save Rawmap As...** | Pick a file and write the map you are editing to it. Later **Save Rawmap** clicks go to the same file. |
| **Open *file* as New Map** | Open the rawmap that is waiting. It shows the file name, and it is grey when no file is waiting. Use it after you cancel **Load Rawmap...**, or to open a rawmap again after you change it in a text editor. |
| **Keep This Save Path** | Ticked after **Save Rawmap As...**. Untick it to send saves back to the default file. Opening another map also sends saves back to the default file. |
| **Use Rawmaps for Every Save/Load** | Off by default. On, every map you open is replaced by the **Load Path** file, and every DOOM Save also writes the **Save Path** file. The console commands `sh_rawmaps_on` and `sh_rawmaps_off` do the same. |

Under these options, **Load Path** and **Save Path** show the files Snapmap+
uses. Hover over one to see the full path.

A rawmap you open is a new map. DOOM's own Save asks for a new name, so it
does not replace the saved map it opened over. If Snapmap+ cannot give that
protection, it refuses to load rawmaps. Opening a rawmap in place needs at least
one local map saved through DOOM. You can also open a map from DOOM's list while
a rawmap is waiting.

A save is refused when no map is open in the editor. A save is cancelled if you
leave the map before it runs.

Rawmaps are saved as compact JSON on one line. To save them with line breaks and
indents, type `sh_pretty_on 1` in the console before you save. Type
`sh_pretty_on 0` to go back to compact JSON.

Run `sh_rawmaps help` for the console commands. `sh_rawmaps list [folder]`
lists rawmap files, `sh_rawmaps load <path>` stages a file, `sh_rawmaps load`
opens it, and `sh_rawmaps save [path]` exports the live map. Console loads
discard unsaved edits without a confirmation prompt. The advanced command
`sh_rawmaps overwrite on` allows DOOM's Save to replace the borrowed saved map;
that choice lasts only until DOOM closes. Keep it off to preserve that map.

---

## Mods

A **mod** adds content the game does not offer in SnapMap: campaign demons such as the Cyberdemon,
Hell Guards and the Spider Mastermind, the campaign pistol with its charged shot, props, doors, sounds,
and whole multiplayer arenas as modules. A mod is a folder of already-cooked DOOM files plus a small
description, installed under `%LOCALAPPDATA%\snapmap-plus\mods\`. Snapmap+ serves those files to the
game in place of, or in addition to, the game's own archives, so a modded entity appears in the Toybox
with a name and description and plays like any other.

Mods run on the author's PC and on every player's PC. A map that uses mods needs Snapmap+ on each
machine that plays it; console players and players without Snapmap+ cannot play it. Published maps
that use mods carry the search tag **mods** so players can tell in advance.

### The Mods tab

![Mods tab: the installed list grouped by origin on the left, the selected mod's details on the right](images/mods-tab-dark.png)

The **Mods** tab lists every mod installed on this machine, grouped by where it came from: **Your
mods** (folders you made or dropped in), **Installed** (added through the tab or the console) and
**From maps you played** (downloaded when you played a published map). Each row carries a status icon:
a green check means installed and serving, a yellow triangle means it needs attention (hover the icon
for the reason, for example two installed folders declaring the same id), and a grey dot means another
build of the same mod is serving its files. The yellow badge in the panel head counts the rows needing
attention and filters the list to them when clicked.

The toolbar has the filter and four icon buttons: **refresh**, **open the mods folder**, **migrate** (only
while an old `overrides\` folder still holds packages Snapmap+ has not moved), and the **download icon**,
which installs a mod from a folder anywhere on disk. The map icon in the panel head opens the map
window described below.

Select a row to read about the mod:

- **About**: id, version, build number, author, description, the folder (click to open it in Explorer)
  and where the mod came from.
- **What it adds**: the Toybox rows it contributes, and how many stock files, sounds, movies, modules
  or virtual textures it brings.
- **Files**: how many files the mod carries and their size, and how many are read from your own
  installed game. Files identical to the game's own are never stored or uploaded; Snapmap+ reads them
  from your install.
- **Requirements**: console settings the mod needs while active, and the reminder that every player
  needs Snapmap+ to play a map that uses it.
- **Sharing**: how many of your published maps use it, when it was last built, and its bundle number,
  which you can quote when asking for help.

The head actions are **Verify** (rehash the mod's files), **Rebuild** (build it again from its folder)
and **Uninstall**, described below.

### Editing a mod while the game runs

Edit files in `mods\<your folder>\`, then click **refresh** (or run `sh_mods rescan`). The changed folder
is built again and the running game takes the change: edited decls are re-parsed, changed models and
images reloaded, new Toybox tiles appear with their names and removed ones disappear, all without a
restart. A change made while you are in Play applies when you return to the editor. Only a changed
sound bank or animation file still needs a restart; the refresh result says so when it happens. Maps
you saved with an earlier build of the mod keep working with the current one.

### The map window

![Map window: the open map's details and the mods it uses, each with a Remove from map button](images/mods-map-modal-dark.png)

The map icon in the left panel head opens a window about the map you have open: its name, saved-map id,
whether it is published and whether its mods are on the server, whether it carries the **mods** search
tag, how many mods it uses and how much a player would download, and when it was last saved. Below that,
**Mods in this map** lists each mod the map is linked to, with how many placed entities use it and which
wires or timelines reference them.

**Remove from map** deletes a mod's entities from the open map. Before anything happens you see exactly
what will go: the entities by name, the wires and timeline references that will be severed, the mod's row
in the map's list, and the **mods** tag if this was the last mod; the copy already published on the server
is unaffected until you publish again. The two buttons are **Cancel** and **Delete from map**. One Ctrl+Z
in the editor brings the entities and their wires back, also after a Play round. When the last mod is
removed, the window says the map is now vanilla: it plays without Snapmap+.

### Uninstalling a mod

**Uninstall**, in the details pane, removes a mod from this computer. If the open map uses it, the map is
cleaned first with the same consequence list as above; then the mod's Toybox rows are removed from the
editor and the folder goes: a folder Snapmap+ installed is deleted, a folder you made yourself is moved to
`%LOCALAPPDATA%\snapmap-plus\removed-mods\` so your work is not lost. Other saved maps that use the mod
will ask for it again when you load them. The folder removal cannot be undone, so the confirmation says
so. The Mods tab is refused these actions during Play or while a map is loading.

### Playing a map that uses mods

Open the map as usual, from Community or My Maps. If it names a mod this machine does not have, DOOM's
own Yes/No dialog names the mods and their total size. **Yes** downloads them from the Snapmap+ mod
store, checks each file against its recorded hash, installs them and starts the map. **No** leaves the
map unloaded and says which mod it needs. Joining a lobby asks the same way. A map whose mods are
already installed, and a map without mods, start exactly as before.

### Publishing a map that uses mods

Publish from DOOM's editor as usual. Before the map reaches the map service, Snapmap+ uploads the mods
the map uses to the mod store at `api.snapmapplus.com`, so other players can download them. The first
time you publish a map with mods, the game asks once whether you agree to upload; **No** leaves the map
unpublished. A map over the map service's 10 MB limit is refused before anything is sent.

Plain saves never upload anything. Publishing the same map again after editing a mod sends the new build
and replaces the old one on the server; players who already have the old build are offered the new one
when they open the updated map. Unpublishing a map releases its mods, and a mod no published map uses
any more is deleted from the server at once. Deleting a map from My Maps while its published copy stays
available keeps its mods on the server.

To share a map without publishing it, `sh_mods export "<path.zip>"` writes the open map and the mods it
uses into one ZIP, and `sh_mods import "<path.zip>"` on another machine installs those mods and stages
the map. A plain rawmap names the mods a map needs but does not carry their files.

### Authoring a mod

A mod folder holds two things:

```
my-mod\
  mod.json
  assets\
    generated\decls\entitydef\mods\alex.imp-variant\imp_blue.decl
    generated\decls\snapeditorentitydef\mods\alex.imp-variant\imp_blue.decl
    generated\decls\md6def\mods\alex.imp-variant\imp_blue.md6.decl
    ...
```

`assets\` mirrors the game's own resource paths: every file sits at exactly the path the game asks for,
already cooked in the game's formats. Snapmap+ does not convert models, textures or sounds from other
games; that is the job of Doomforge, the companion import tool. Put new content under your own name,
`mods/<id>/`, so it never collides with the game's or another mod's files. A file whose path is the same
as a stock file replaces that file for everyone who plays the map; list such files in `shadows` so the
replacement is deliberate.

`mod.json` is the part you write:

```json
{
  "id": "alex.imp-variant",
  "name": "Blue Imp",
  "version": "1.0.0",
  "author": "alex",
  "description": "A recoloured Imp with its own Toybox entry.",
  "strings": {
    "en": {
      "snapmapplus_imp_blue_name": "Blue Imp",
      "snapmapplus_imp_blue_toybox_desc": "An Imp with a blue hide."
    }
  },
  "requirements": {
    "cvars": { "g_useResourceBlackList": "0", "g_useImageBlackList": "0" }
  }
}
```

- `id` is the mod's identity: 1 to 64 characters, lower-case letters, digits, dots, hyphens and
  underscores, no punctuation at either end, unique to you (a `yourname.` prefix is the convention). Two
  installed mods with one id are both kept and both flagged until you change one.
- `name`, `version`, `author` and `description` are what players see in the Mods tab.
- `strings` supplies the Toybox names and descriptions your decls refer to as `#str_...` ids, per
  language code.
- `requirements.cvars` names console variables the mod needs while it is active. The two blacklist
  cvars above are needed by any mod that brings campaign-only models or images into SnapMap.
- `hud` adjusts the ammo panel for a weapon mod: `{"weapons": {"weapon/zion/player/sp/pistol":
  {"ammo_display": "weapon"}}}` lets the campaign pistol show its infinity symbol instead of a forced
  number.
- `stock` names installed game files under your own paths without copying them:
  `{"<request path>": {"source": "<installed path>"}}`.
- Any other key of your own is kept as it is.

When Snapmap+ builds the folder it adds one member, `"snapmap-plus"`, holding the list of files, their
hashes, the bundle number and whether the mod verified. Leave it alone: it is rewritten on every build,
and everything else in the file, your formatting included, is never touched. A folder that still uses
the older `package.json` name is converted to `mod.json` at its first build. The folder's name is yours
to choose; the id inside `mod.json` is what identifies the mod.

What a mod can carry, beyond entity and model decls:

- **Sounds**: a sound decl under `generated/decls/sound/mods/<id>/` plays the Wwise event its file name
  gives, so a mod can reuse any stock sound without shipping a bank, and a mod's own bank at
  `sound/soundbanks/pc/<id>_<name>.bnk` is loaded when the editor opens or a map loads.
- **Flash movies** (`.bswf` with their `.bimage` atlases) under `generated/swf/`, for HUD and menu
  replacements.
- **Modules**: a module decl at `maps/modules/mods/<id>/<name>.decl` with stock pointers for its render
  model, collision, navigation and the rest, so a campaign or multiplayer arena loads as a room that
  moves, saves and plays like a stock module.
- **Virtual-texture families** under `virtualtextures/mods/<id>/`, for materials with their own streamed
  detail.

Unchanged copies of the game's own files are never stored or uploaded: the build records them as
pointers to the installed game, and a player whose install lacks that content is told so. To get the
bytes of an installed file as a starting point, `sh_mods copystock "<engine path>" "<file>"` writes it
out.

The full file format and every detail of what the game accepts are documented in the product
repository's [capabilities](https://github.com/doom-snapmap/snapmap-plus/blob/main/docs/capabilities.md#mods)
and [architecture](https://github.com/doom-snapmap/snapmap-plus/blob/main/docs/architecture.md#mods) pages.

### If you used packages before the April 2024 port

Releases up to v0.2.1-beta.19 kept packages in `%LOCALAPPDATA%\snapmap-plus\overrides\`. The first
start of this release moves every package there into `mods\`, once, each in its own folder with a
`mod.json`, and records the outcome in `mods\snapmap-plus.json` and in the log. Nothing in `overrides\`
is changed or deleted; once you are happy with the result you can delete it. Maps saved or published
with packages by those releases load with the matching mods. If you change `overrides\` later,
`sh_mods migrate --again` repeats the move, and the Mods tab shows the migrate button while anything
there is still pending.

### Mod console commands

Everything the Mods tab does is also a console command.

| Command | What it does |
|---|---|
| `sh_mods` or `sh_mods status` | Show what the installed mods serve, and whether a refresh is pending. |
| `sh_mods list` | List the mod folders. |
| `sh_mods rescan` (alias `refresh`) | Reread `mods\`, rebuild changed folders, and push the changes into the running game; prints what was re-parsed, reloaded, and what still needs a restart. |
| `sh_mods build "<folder>"` / `sh_mods rebuild "<folder>"` | Check one folder and write the `snapmap-plus` block of its `mod.json`; rebuild also rescans. |
| `sh_mods install "<folder>"` | Copy a folder from anywhere into `mods\`, check it and serve it. |
| `sh_mods verify "<folder>"` | Rehash one mod (a folder, an id or `id@version`). |
| `sh_mods map` | Show the open map's details and the mods it uses, with placed-entity counts. |
| `sh_mods map remove "<id>" [--yes]` | Print what removing the mod from the open map would delete; `--yes` does it. |
| `sh_mods uninstall "<id>" [--yes]` | Print what uninstalling the mod would do, map cleanup included; `--yes` does it. |
| `sh_mods doctor [verify]` | Explain every mod's state, the conflicts between mods and every stock file they shadow. |
| `sh_mods palette rebuild` | Rebuild the editor's Toybox rows by hand (refresh does this for you). |
| `sh_mods copystock "<engine path>" "<file>"` | Write an installed game file's bytes to a file. |
| `sh_mods export "<path.zip>"` / `sh_mods import "<path.zip>"` | Write the open map with its mods to a ZIP, or install a ZIP's mods and stage its map. |
| `sh_mods push` / `pull` / `release` / `retry` / `cancel` | Talk to the mod store directly; publishing does this for you. |
| `sh_mods migrate [--again]` | Move `overrides\` packages into `mods\` again. |

---

## Inside DOOM's Editor

Some of Snapmap+'s features live inside DOOM's own editor rather than in the
Snapmap+ window: the **Module Properties** panel, the **SNAPMAP+ MOD SETTINGS**
tab under **Settings > Properties**, and the Start menu. They change the shape
of a map itself, from the size of a room to the distance the game draws, and
each one says whether a map that uses it still plays for people without
Snapmap+.

### Resizing Grid Rooms

Highlight a **classic or modern Grid Room** in DOOM's editor and press **X** to
open **Module Properties**. Change **Grid Room Size** X, Y and Z. This works in
Blueprint mode and keeps the Blueprint camera. Left Ctrl opens the action menu;
the size controls are in DOOM itself.

Each room keeps its own dimensions. Doors and frames stay their original size,
and all of the room's built-in lights follow the resized room: they spread with
the walls, the ceiling light stays just under the roof, and the room looks the
same after you save and reload it. Brightness and color do not change. Objects
you placed keep their module-local positions and sizes, so inspect objects near
the walls after shrinking. Connected branches move to retain their doorways;
conflicting connection loops and new overlaps can prevent an edit.

| Grid Room | Original X / Y / Z | Minimum X / Y / Z |
|---|---|---|
| Classic | 2560 / 2560 / 2048 | 416 / 416 / 304 |
| Modern | 5120 / 5120 / 3392 | 864 / 272 / 432 |

Out-of-range values clamp and the panel shows the applied dimensions. Only the
value you changed is adjusted. If a room cannot grow further on that axis, the
panel keeps the size that fits; the Snapmap+ log (`sh_backend.log`) says which
room or connected module reached which limit. A room that already extends past
the limit can always be made smaller. The maximum
follows the current `snapEdit_environmentModuleBounds` cvar, the room's world
position and its connected neighbors. Raising that cvar allows larger rooms
without restarting, up to native collision and navigation coordinate limits.
Snapmap+ does not change the cvar for you. The current process retains up to
64 distinct size/type combinations; restart DOOM if that cache fills.
Keep the world cvar large enough when reopening or playing a map authored with
a raised limit; the room dimensions are saved, but this cvar is not stored in
the map. For example, `snapEdit_environmentModuleBounds 30000` permits a larger
world box, while each room still has to fit at its actual position.

Save and load normally. Collision, navigation and marked blocking-volume
navigation use the resized room. **Players need Snapmap+ to load these maps.**
The resizing feature is included in the existing backend DLL; it needs no
separate file beside the map.

To return a map to vanilla compatibility, restore every Grid Room to its
original dimensions, turn **Unlock View Distance** off, and remove any
other mod-only content. Save again.

The faint green surface grid appears when placing or moving objects that use
the game's navigation placement display, such as demons. Its brightness pulses,
so it can become very faint while still enabled. It follows the room's native
display surfaces, rather than covering every wall or appearing for every prop
or logic object. **Snap to Grid** moves the held object to the editing grid;
it does not toggle this display. The custom blocking-volume navigation preview
is a separate overlay.

### Placing objects anywhere

With Snapmap+ installed you can place or move any object anywhere in Object Mode, including in
open air. Demons, the player start, encounter spawners, AI path and combat points, item hints and
pickups normally turn red and refuse to be put down unless they touch a floor; with Snapmap+ they
stay green and are placed exactly where you hold them. A floor or wall under the object still
works as before, and **Z (Drop to Floor)** still drops it straight down. An object that overlaps
another one, or that is outside every module, is still refused.

The map stores only each object's position, so it opens normally without Snapmap+. There, a
floating object stays where you put it, but if someone picks it up it turns red and can only be
put down again on a floor.

In Play, a player start in the air starts the player on the floor below it, and demons placed in
the air are on the floor once they become active.

## Map bounds and Blueprint zoom

Snapmap+ adds a third tab to DOOM's **Settings > Properties** panel. Switch
tabs with the bumpers (or Q / E) or click the third diamond at the top of the
panel; the tab is titled **SNAPMAP+ MOD SETTINGS**. Every setting on it is a
Snapmap+ mod. Stepping a number past either end of its range stops at that end.
If the tab cannot be installed on your game build, the same controls appear at
the end of the first tab.

| Setting | Default value | Values |
|---|---|---|
| Unlock Map Bounds | Off (16000, native) | Off or On (32671 game units) |

**Unlock Map Bounds** is an on/off setting. SnapMap normally marks any module
that reaches beyond 16000 units from the map center in X, Y or Z as an invalid
placement. Turning it on widens that box to the largest size the game can
handle, 32671 units, for this map; the editor camera, the Blueprint floor grid
and the Blueprint floor range follow. Choose **Apply**, then save the map; the
setting is stored inside the map and is used whenever the map is edited, played
or loaded directly. A map saved by an earlier Snapmap+ version with a number
between the two keeps that number and shows the setting as On until you change
it.

The highest value is 32671. Collision and AI navigation store world positions
as 16-bit numbers that end at 32767, and navigation reaches up to 96 units
beyond a module, so modules cannot go farther even with Snapmap+.

Only Snapmap+ can open the extra space. Each PC checks module positions with
its own limit when it loads a map, so players without Snapmap+ see the modules
past 16000 as invalid and the game can crash loading the map. Keep the default
for maps you want everyone to play. Turning the setting off removes the
requirement, as long as no module still sits outside the native box.

Snapmap+ also lets the Blueprint camera zoom out until the whole map fits on
screen, on any map: up to 44000 units above the floor instead of DOOM's 16000,
or about 90000 when the map uses **Unlock Map Bounds**. While you are zoomed
out in Blueprint the game draws far enough to keep the floor in view, and the
editor's fog-free space is enlarged so the camera never ends up looking through
a thick blue fog. This is an editor convenience on your PC only and changes
nothing in your maps.

Because the zoom-out limit grows with the map bounds, a fully zoomed-out map
with **Unlock Map Bounds** fills the screen just as a native map does: the
floor grid and the space for modules are about twice as wide in game units,
but they look the same size on screen. Compare the two at the same camera
height to see the difference. Modules can be hovered, grabbed and placed from
any zoom level.

### Unlock view distance

Open **Settings > Properties** in DOOM's SnapMap editor and switch to the
**SNAPMAP+ MOD SETTINGS** tab; the setting is **Unlock View Distance**. Choose
**Apply**, then save your map normally. Cancel discards unapplied changes. The
setting is saved into this map and works with both OpenGL and Vulkan. Loading
another map uses that map's own setting.

| Setting | Default | Values |
|---|---|---|
| Unlock View Distance | Off | Off or On |

- **Off (default):** the map is drawn exactly as the unmodified game draws it.
  Each environment keeps its own far-clip distance and its own fog, and
  modules, **Set Environment** and **Player Set Environment** logic nodes and
  campaign environments such as the Lazarus archive (15000) all keep control.
  A room on the **Default** Environment FX draws to 60000 units in the editor,
  darkening into fog after about 32000, but only 8192 units in Play. Many other
  Environment FX stop at 8000, 8192, 10000 or 32768.
- **On:** the map draws to 200000 units, the farthest the game allows, in the
  editor (every camera, Blueprint included) and in Play. Each Environment FX
  keeps its look: its fog, color, grading and lighting stay, and its fog is
  stretched by the same factor as its distance, so fog that used to close in at
  the old far clip now closes in at 200000 instead. Set Environment and Player
  Set Environment nodes still change the environment; only the distance is
  replaced and the fog stretched to match. It is not infinite.

Turning the setting on modifies the map: it is stored in the map as a string
variable named `smp.render.v1`. Turning it off and applying removes that
variable again, so the next save writes the map exactly as the unmodified game
would. Players without Snapmap+ can load a map saved with it on; they see the
map with its original environments.

On a four-room test map, frame times were the same with the setting on and off
(the game stayed at its 60 frames per second limit in the editor and 200 in
Play either way), but a large open room with many objects in view can still
cost more, because nothing past the old distance is cut away any more.

Fog is not a map setting. Use environments and Set Environment nodes for fog;
with this setting on their fog is kept but drawn farther out.

Maps saved with earlier Snapmap+ versions, which stored a View Distance number,
read as follows: a distance of 8192 (the old default) reads as **Off**, and its
variable is removed the next time the map is saved; any other distance,
including 0, reads as **On**. Their old map fog values are ignored. Maps saved
with the former enable switch off read as **Off**.

### AI navigation on Blocking Boxes

Enable **AI Navigation** and **Block Demons** on a Blocking Box to use its exposed,
walkable surfaces for demon navigation. Rotating a box can make one of its sides
the new walking surface. Slopes retain their actual angle, and overlapping boxes
contribute their exposed surfaces.

Default-sized boxes work too, including in maps created before Snapmap+ was
installed, and they keep their navigation preview after you save. You do not need
to resize a box or recreate the map to enable navigation.

For a wall that demons should go around, leave **AI Navigation** off and keep
**Block Demons** on. Ordinary Blocking Boxes already participate as obstacles,
including where they overlap custom navigation. Enable AI Navigation when the
box should also provide a walkable top or slope. Vertical walls and downward
faces do not become walking surfaces; climbing uses approach and landing
connections between valid surfaces.

The green preview shows the smallest demon navigation size. Larger demons need
more standing room and clearance, so a narrow green surface may still be too small
for a hell knight. Climbing also requires an available traversal animation and
clear approach and landing positions; the floor-side positions account for the
whole rotated box, including an overhanging slope.

Demons climb a marked box from any side whose foot is open floor, not only from
the side whose floor strip happens to match the box's: a box set across one of a
room's floor seams gets climbs on all of its free faces. Each long face carries
several climbing points, roughly every 192 units of edge, so a demon standing
beside a step uses the nearest one instead of walking to the middle of a far
face. The room's own floor is cut around every box that stands on it, or that
hangs over it lower than the demon is tall, the same way a box top is cut around
a box standing on it: a demon routes around the box to a climbing point rather
than walking into its side. A box high enough to walk under leaves the floor
alone. Every climb, drop and leap is also checked along the path the animation
takes, so a demon never climbs or drops through a box, a floor slab or a
neighbouring step; where a run-up would start under an overhang it is moved
into the open, and a climb with no clear path is left out.

When you build a staircase from overlapping, floating boxes, the step above
shadows the faces of the step below it, so a fanned stair may keep floor climbs
on only two or three faces of its first step. Run `sh_navmesh` to see, for each
box and demon size, which faces have a climb and why the others do not
("blocked" means another box overhangs the run-up, "inside" means the face is
buried in another box).

Once the navmesh has been built, the faint green placement grid you see while
holding a demon follows it: the grid stops around every AI Navigation box the
demon would have to walk around, leaving a margin as wide as that demon's
clearance, and carries on under a box that is high enough for it to walk
beneath. Larger demons leave wider gaps, so pick up the demon you intend to
place to see exactly where it can stand; unticking AI Navigation on every box
in a room brings back the room's normal grid.

A map can hold up to 65,536 boxes with **AI Navigation** or **Block Demons** and
8,192 placed modules. Each module copy (a "room" in the messages) bakes up to
2,048 boxes, and up to 2,048 walkable pieces per demon size. Past any of these the
extra boxes are left out and named, and the rest of the map keeps its navigation.

When something does not fit, Snapmap+ leaves out the smallest part it can instead
of refusing the map:

- A box whose size, rotation or room cannot be read, or that two rooms claim, is
  left out on its own. A box in a room whose position cannot be read is left out
  with that room's other boxes only.
- The engine allows at most 256 routes out of one navigation area. When a busy
  floor would pass that, the boxes adding the most routes there give up just
  enough of them.
- The engine loads no navigation tree deeper than 128. The generated part of
  the tree is rebuilt balanced after every route is placed, so even hundreds of
  boxes stay well inside that; a room that would still pass it keeps three
  quarters of its floor boxes at a time until it fits.
- One room's navigation file is kept within 16 MiB. Very many boxes close
  together (hundreds within jumping range of each other) can pass that. A leap
  to a far box top is dropped when a nearer landing already reaches the same
  box with a shorter leap, so every top stays reachable with far fewer links.
  The room then keeps the shortest moves out of each box and gives up the
  longest leaps until it fits; only if that is not enough does it give up floor
  boxes, three quarters at a time.
- Each demon size is baked on its own. If the smallest size cannot be built,
  larger demons still use the boxes, and a size that failed is not baked again
  at Play unless the map changed.
- A room that cannot be built at all keeps its normal navmesh; the other rooms
  are still built.

Boxes that lost routes or were left out this way are drawn amber in the preview.
The completion toast says **Navmesh Built**, **Navmesh Partly Built** with how
many rooms were built and the first room that kept or lost something and why, or
**Navmesh Build Failed** when no room could be built or the map could not be read.
The View menu shows the same summary. Run `sh_navmesh` in the game console: it
prints one block per room and demon size with the counts, one reason per line
and a table of which box faces demons can climb from the floor;
`sh_backend.log` has the same facts on single lines. The one route refusal left is a module whose own navigation already fills
an area; the boxes routing into it are marked red. An obstructed or disconnected
route can also stop a demon without removing the navigation mesh. Leave enough
room around wall ends for the intended demon size and keep spawn, approach and
landing points clear.

Build navigation from the editor's Start menu with **Build Navmesh**, below
**Save As** and above **Play**. The game shows **Building Navmesh** while the worker runs, then a
native completion toast, just like ordinary Save. This does not save or name
the map, and it does not require a player start. It also works in Blueprint mode
and with the green preview turned off.

The same operation is available through **View > Update Navmesh** in Snapmap+.
The preview is read when the map opens and when you request an update.
Editing does not read the map. When you add, delete, move or change
the flags of a box with **AI Navigation** or **Block Demons**, the View menu says
**Navmesh is out of date**. Other edits do not change it. The preview hides while
geometry is held. Play always uses the current map: if it changed since the last
update, Play bakes it again, but only the rooms that changed. Each room's
navigation for all three demon sizes is kept after it is built, so a room whose
boxes and position are unchanged is not baked again at the next Play, after
reloading the map, or when it is launched from outside the editor. Build Navmesh and the preview bake all three demon sizes, so the first Play
reuses them. If the View menu says **Could not read this map**,
run `sh_navmesh` for the reason.

Duplicated boxes that share an ID keep their navigation when the map assigns
that ID to one module. An ID assigned to different modules is ambiguous, so the
boxes carrying it are left out; the rest of the map keeps its navigation.
Baking runs in the background, so the previous lines can remain briefly while the new
result arrives. `sh_perf` reports time spent reading the map and building the
preview; `sh_perf reset` clears those counters.

---

## SnapStack (Bulk Editing)

**SnapStack** lets you edit many entities at once from the **DOOM console** (press **~** to open it),
instead of one at a time through the Entity State panel. Every command starts with `sh`.

### The stack/group model

Most SnapStack commands work against a **stack** — a scratch list of entities, numbered (stack 0 is the
default) — or a **group**, a *named* list that (unlike a stack) doesn't get cleared out after you use it.
Groups are what you want for running several edits against the same set of entities without reselecting
them each time.

- `sh psel [stack]` — takes your current in-game selection and pushes it onto a stack (default stack 0).
  De-selects everything in-game once it's stored, and reports how many entities landed in which stack.
  Right-clicking a row in the Entities tab and choosing **Push to stack 0** does the same thing for that
  one entity.
- `sh phov [stack]` — pushes whatever entity you're currently hovering (not necessarily selected) onto a
  stack. Pushing the same one twice doesn't duplicate it.
- `sh pr [stack] [lo] [hi]` — pushes every valid id in the inclusive range `lo..hi` onto a stack, without
  needing to select any of them first.
- `sh pg [name] [stack]` — pushes a named group's ids onto a stack (`sh pg [name]` alone targets stack 0)
  — the reverse direction of `pop2g` below.
- `sh pop2g [stack] [name]` — moves a stack's contents into a named group (replacing that group's
  previous contents, if any).
- `sh popsel [stack or group]` — re-selects, in-game, everything stored in a stack or group. Useful both
  for finding something you can only see in the Entities list, and for pulling a group's contents back
  into a stack you can run other commands against.
- `sh cstk [stack]` — empties a stack out. (Right-clicking in the Entities tab and choosing **Clear stack
  0** does the same thing for stack 0 specifically.)

### Narrowing a stack

Once a stack has entities in it, you can filter it down before running an edit — useful when a selection
(or a range/group) contains more than what you actually want to change:

- `sh filtinh [stack] [inherit]` — keeps only the stacked entities whose **inherit** matches.
- `sh filtcls [stack] [classname]` — keeps only the stacked entities whose **classname** matches.

### Bulk-edit commands

All of these take `[stack or group]` first, then more arguments, and (when a stack is used) clear that
stack once they run:

| Command | What it sets |
|---|---|
| `sh bsi [stack/group] [property path] [value]` | An integer property |
| `sh bsf [stack/group] [property path] [value]` | A float/decimal property |
| `sh bsb [stack/group] [property path] [value]` | A boolean property (`true`/`false`) |
| `sh bss [stack/group] [property path] "[value]"` | A string property (quote the value) |
| `sh bsin [stack/group] [inherit path]` | The **inherit** of every entity in the stack/group |
| `sh bscls [stack/group] [classname]` | The **classname** of every entity in the stack/group |
| `sh bsincls [stack/group] [inherit] [classname]` | Both inherit and classname together, safely (no momentary mismatch) |
| `sh bse [stack] [property path]` | Sets a string/reference property on every OTHER entity in the stack to the ID of the LAST entity selected before `sh psel` |
| `sh accl [stack]` | Pops the LAST entity selected before `sh psel` as a receiver, and reference-assigns every OTHER entity in the stack onto it |
| `sh acctargets [stack]` | Appends every OTHER entity in the stack to the `targets` list of the LAST entity selected before `sh psel` |

`[property path]` uses dots for nested properties — `clipModelInfo.size.x`, `renderModelInfo.color.r`,
and so on, the sub-property you want to change written last. Get `inherit`/`classname` wrong together
(with `bsin`/`bscls` alone rather than `bsincls`) and you risk the same mismatch crash as reclassing a
single entity by hand — see [Reclassing an Entity](#reclassing-an-entity).

`bse`, `accl`, and `acctargets` all need to know which entity was selected *last* — since groups don't
track that, those three only work against a stack.

One more, a bit different from the rest: **`sh mkcmd [stack]`** synthesizes a reusable command-entity
macro out of everything currently in a stack, rather than editing a property on each entity directly.

### A few worked examples

**Retexture a group of objects at once:**
```
(select the objects to receive the property)
sh psel
sh bss 0 renderModelInfo.customMaterial "material/snapmap/dynamic_block_solid"
```

**Bind several objects to a mover, all at once, with rotation:**
```
(select the objects to bind, not the mover)
sh psel
sh pop2g 0 binds
sh bsb binds bindInfo.bindOriented true
sh popsel binds
(select the mover)
sh psel
sh bse 0 bindInfo.bindParent
```

**Wire one entity to signal several others via `targets`, quickly:**
```
(select the entities that should be signaled)
(then also select the entity that will do the signaling — last)
sh psel
sh acctargets 1
```

### New in Snapmap+

A few extra commands beyond the original SnapStack set, for inspecting stacks/groups directly instead of
guessing what's in them:

| Command | What it does |
|---|---|
| `sh chkstk [N]` | Inspect stack `N` (ids + id-strings); omit `N` to summarize every non-empty stack. |
| `sh chkgrp [name]` | Inspect a group's ids; omit `name` to list every group and its count. |
| `sh clrgrp <name>` or `sh clrgrp *` | Delete a named group entirely (`*` deletes all of them). |
| `sh snapstack_diag` | Diagnostic: reports which SnapStack implementation is currently handling commands. |

---

## Advanced: Every Console Command

Everything above covers Snapmap+ through its window. Snapmap+ also adds a set of commands straight to
DOOM's own console (press **~** to open it) — some are shortcuts for things the window already does,
others are console-only tools with no window equivalent. Run **`sh_help`** at any time to print the
full, current list with descriptions directly from the running build; the tables below are the same
list, organized by what each command is for. (Not repeated here: `sh` and its bulk-edit subcommands,
`sh_target_any`, `sh_rawmaps_on` / `sh_rawmaps_off`, and `sh_mods` — those are covered in their own
sections above.)

### Inspecting entities and resources

| Command | What it does |
|---|---|
| `sh_spawn <entitydef> <name>` | Spawn an entity definition at your position and teleport to it. |
| `sh_dumpdef <entity name>` | Print — and copy to your clipboard — an existing entity's resolved entity definition. |
| `sh_spawninfo` | Generate `spawnOrientation` / `spawnPosition` values from your current position in the map. |
| `sh_entlist` | List every editor entity type the engine knows about. |
| `sh_listres <resource class> [filter]` | List every resource of a given class (e.g. `idMaterial`), optionally filtered by name. |
| `sh_type <type or enum> [-v]` | Print the fields of an idTech class, or the values of an enum. Add `-v` to also see each field's byte offset and size. |
| `sh_validclasses <inherit>` | List the engine-valid classnames for a given inherit — the same list that fills the Classname dropdown in the [Entity State Panel](#the-entity-state-panel). |
| `sh_dumpmap <name>` | Dump the currently generated `.map` (including SnapMap's own auto-generated version) to a file, for debugging. Works in the SnapMap menu as well as in the editor. The name is **game-relative**, not a Windows path: a bare name lands in `<game dir>\base\mapdumps\<name>.map`, and the `.map` extension is always forced. Dumping the same name twice never overwrites — repeats become `<name>_2.map`, `<name>_3.map`, and so on. Pass a name containing a `/` (e.g. `arena/pass1`) to choose your own subfolder under `base\`; it is created for you. The command prints the full path it wrote. |

### Rawmaps

| Command | What it does |
|---|---|
| `sh_rawmaps` | Show the rawmap state, the Load Path and the Save Path. `sh_rawmaps help` lists every verb: `list`, `on`/`off`, `load`, `save`, `savepath`, `default` and `overwrite`. See [Rawmaps](#rawmaps). |

### Compiling assets

| Command | What it does |
|---|---|
| `sh_genbmodel <input> <output>` | Generate a bmodel from a `.obj`, `.ase`, or `.lwo` file. |
| `sh_genmd6model <input> <output>` | Compile a `.md6model` into a `bmd6model`. |

### Player cheats

Five toggles for your own player, mainly useful while testing a map solo:

| Command | What it does |
|---|---|
| `noClip` | No-collision flight. |
| `infiniteHealth` | You can't lose health. |
| `noPlayerDeath` | You can't die. |
| `noPlayerKill` | You can't be killed outright. |
| `noTarget` | Enemies ignore you. |

### Cvars

Settings you read or change with `<name>` or `<name> <value>` in the console:

| Cvar | Default | What it does |
|---|---|---|
| `sh_pretty_on` | `0` | Type `sh_pretty_on 1` to turn on, `sh_pretty_on 0` to turn off. On, it pretty-prints every rawmap Snapmap+ saves: **Save Rawmap**, **Save Rawmap As...**, `sh_rawmaps save`, and DOOM's own Save while **Use Rawmaps for Every Save/Load** is on. At `0`, rawmaps are compact JSON. |
| `sh_copy_reslist_to_clipboard` | `0` | Copy `sh_listres` output to the clipboard automatically. |

### Developer and diagnostic tools

The rest exist mainly for Snapmap+'s own developers to debug the engine hooks — you're unlikely to need
them, but they're listed here for completeness since `sh_help` shows them too:

| Command | What it does |
|---|---|
| `sh_navmesh` | Show the baked AI navigation the current map uses: which modules and nav classes, or why a bake was refused. See [AI navigation on Blocking Boxes](#ai-navigation-on-blocking-boxes). |
| `sh_navmesh marks [count]` | Mark navigation boxes red in the preview, the same way a refused bake marks them. It marks up to `count` boxes in each module (default `4`, maximum `24`). `sh_navmesh marks 0` clears the marks. |
| `sh_perf` | Show where Snapmap+ spends frame time, such as reading the map and building navigation previews. `sh_perf reset` sets the counters to zero. `sh_perf read` times two ways to read the open map: the whole map at once, and each entity one at a time. It also estimates the cost to read only the navigation boxes. Run it with a map open in the editor. |
| `sh_alginfo` | Report the status of Snapmap+'s optional math-acceleration layer. |
| `sh_debugrender` | Renderer debug toggle; `sh_debugrender dumprenderinfo` prints how many rendermodels are active, then names them. |
| `cs_dontuse` | Toggle higher-precision engine-math overrides — a performance tradeoff, off by default; the name is the warning. |
| `sh_superscriptop` | Dump SuperScript / eventDef data. |
| `cs_dumpeventdefs` | Dump every eventDef to a file. |
| `cs_fieldinfo` | Print field info for a type. |
| `cs_start_render_logging` | Set up the render-logging hook. |
| `sh_disable_devmode` / `sh_reenable_devmode` | Turn DOOM's developer features off, or back on, without losing your Bethesda.net connection. |
| `sh_dialogtest [id] [buttons] [text]` | Raise DOOM's own modal dialog carrying the given text. |
| `sh_dialogpoll` | Read the answer to the dialog `sh_dialogtest` raised. |
| `sh_dialogdump` | Print the engine's dialog queue: id, button set, and flag bytes. |

---

## Reporting Bugs and Requesting Features

Snapmap+ has a built-in way to send feedback straight to the developers — no GitHub account, no email,
no leaving the game. Click the small **?** button in the bottom-right corner of the status bar to open
the **Send feedback** dialog.

![The Send Feedback dialog: category, title, details, and an optional contact field](images/feedback-dark.png)

Fill in:

- **Category** — Bug report, Feature request, Incorrect description / info (something in this guide or
  the app's own text is wrong), or Other.
- **Title** — a one-line summary.
- **Details** — what happened, what you expected instead, and steps to reproduce if it's a bug. The more
  specific, the more useful.
- **Contact** *(optional)* — an email, Discord handle, or GitHub username, only if you want a reply.

Each report also carries the Snapmap+ version, the renderer you are running and your game's identity,
such as `DOOM 2016 build 13954591 (20240321-104810-ginger-fuchsia, Vulkan, 3d8b4393)`: the DOOM build, the game's own build name, the renderer
and the start of the executable's fingerprint. That is how the developers tell which DOOM a report came
from; nothing else about your PC is sent.

Click **Send** and it's filed as a public issue on the project's tracker under the category you picked.
If someone's already reported the same thing, Snapmap+ recognizes the duplicate and adds your report as
a note on the existing issue instead of creating a new one.

The same reporting pipeline also backs Snapmap+'s **crash report** dialog: if the game hits a serious
fault, a crash dialog opens (right away if Snapmap+ recovered in place, or on your next launch otherwise)
with the error, an optional description of what you were doing, and a checkbox to attach recent log text
(anonymized — your Windows account and machine name are stripped before anything is sent). Sending it
files a `crash`-labeled issue the same way, and repeat crashes at the same spot get grouped onto one
issue rather than filing duplicates.

Nothing is sent unless you click Send — Snapmap+ makes no other network requests on its own.

**Reporting without the app.** If you open an issue on GitHub yourself, say which DOOM build you are
on: run `snapmap-plus status` in a terminal and paste its `Game:` line (for example
`DOOM 2016 build 13954591 (20240321-104810-ginger-fuchsia, Vulkan, 3d8b4393)`). If Snapmap+ will not install, say whether your game is
the April 2024 update or the 2018 build.
