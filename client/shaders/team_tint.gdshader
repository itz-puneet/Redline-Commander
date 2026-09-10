shader_type canvas_item;
// Tints only the faction-coloured parts of a unit sprite.
//
// The sheet is rendered once, in neutral grey, with a second sheet marking
// which pixels belong to the faction. Tinting through the mask means one
// render serves every player slot - adding a third or fourth faction is a
// colour, not another 10 sprites to render and keep in step.
//
// The grey is multiplied through rather than replaced, so the shading from
// the render survives the tint; TEAM_GREY undoes the material's own value
// so a faction colour comes out at full strength on a lit surface.

uniform sampler2D mask_tex : filter_linear, repeat_disable;
uniform vec4 team_color : source_color = vec4(1.0, 1.0, 1.0, 1.0);

// Must match MATERIALS["team"] in art/blender/render_sprites.py.
const float TEAM_GREY = 0.74;

void fragment() {
	vec4 base = texture(TEXTURE, UV);
	float team = texture(mask_tex, UV).r;
	vec3 tinted = clamp(base.rgb * team_color.rgb / TEAM_GREY, vec3(0.0), vec3(1.0));
	COLOR = vec4(mix(base.rgb, tinted, team), base.a) * COLOR;
}
