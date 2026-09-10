# SVG class vocabulary

Every unit SVG uses the same classes, and only these. The renderer builds
the faction mask by re-rendering the same file with a stylesheet that turns
every `team*` class white and everything else black, so a shape's class is
the single thing that decides whether it takes the faction colour.

| class | role | base fill |
|---|---|---|
| `team-hi` | faction, lit top face | `#cfcfd1` |
| `team` | faction, front face | `#bdbdbe` |
| `team-lo` | faction, shaded side | `#93939a` |
| `dark` | tracks, weapons, rotors | `#43454d` |
| `dark-hi` | lit top of a dark part | `#55575f` |
| `light` | highlights that must read against every faction colour | `#d2d4d9` |
| `glass` | canopies and viewports | `#5b8ab4` |

`team` is `#bdbdbe` because the tint shader divides by `TEAM_GREY = 0.74`
(189/255), so a fully lit faction face comes out as the faction colour
exactly. Keep it in step with `art/blender/render_sprites.py` and
`client/shaders/team_tint.gdshader`.

Coordinates are a 64x64 viewBox - one sprite cell. They were projected
through the same camera as the Blender renders (34 degrees from vertical, a
30 degree yaw) so the two can be compared on the drawing rather than on the
viewpoint.
