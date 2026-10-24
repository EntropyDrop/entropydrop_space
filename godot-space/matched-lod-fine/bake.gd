extends SceneTree
func _initialize() -> void:
	var manifest: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://data/manifest.json"))
	var mask_bytes := FileAccess.get_file_as_bytes("res://data/mask.bin")
	assert(mask_bytes.size() == 1024 * 128 * 2)
	var mask := ImageTexture.create_from_image(Image.create_from_data(1024, 128, false, Image.FORMAT_RG8, mask_bytes))
	var shader := Shader.new()
	shader.code = """shader_type spatial;
render_mode unshaded, cull_back;
uniform sampler2D ownership : filter_nearest, repeat_enable;
uniform bool masked = false;
void fragment() {
 if (masked && (texture(ownership, UV).r > 0.5 || texture(ownership, UV).g > 0.5)) discard;
 ALBEDO = COLOR.rgb;
}
"""
	var root := Node3D.new()
	root.name = "CapturedWebDraws"
	var triangles := 0
	for draw in manifest.draws:
		var bytes := FileAccess.get_file_as_bytes("res://data/" + draw.file)
		var hash := HashingContext.new()
		hash.start(HashingContext.HASH_SHA256)
		hash.update(bytes)
		assert(hash.finish().hex_encode() == draw.sha256, "Geometry hash mismatch")
		var nv := bytes.decode_u32(0)
		var ni := bytes.decode_u32(4)
		assert(nv == int(draw.vertices) and ni == int(draw.triangles) * 3)
		assert(bytes.size() == 8 + nv * 32 + ni * 4)
		var values := bytes.slice(8, 8 + nv * 32).to_float32_array()
		var indices := bytes.slice(8 + nv * 32).to_int32_array()
		var positions := PackedVector3Array()
		var colors := PackedColorArray()
		var uv := PackedVector2Array()
		positions.resize(nv)
		colors.resize(nv)
		uv.resize(nv)
		for i in nv:
			positions[i] = Vector3(values[i * 8], values[i * 8 + 1], values[i * 8 + 2])
			colors[i] = Color(values[i * 8 + 3], values[i * 8 + 4], values[i * 8 + 5], 1)
			uv[i] = Vector2(values[i * 8 + 6], values[i * 8 + 7])
		for i in range(0, ni, 3):
			var swap := indices[i + 1]
			indices[i + 1] = indices[i + 2]
			indices[i + 2] = swap
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = positions
		arrays[Mesh.ARRAY_COLOR] = colors
		arrays[Mesh.ARRAY_TEX_UV] = uv
		arrays[Mesh.ARRAY_INDEX] = indices
		var mesh := ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		var material := ShaderMaterial.new()
		material.shader = shader
		material.set_shader_parameter("ownership", mask)
		material.set_shader_parameter("masked", draw.masked)
		mesh.surface_set_material(0, material)
		var instance := MeshInstance3D.new()
		instance.mesh = mesh
		instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		# These are the Web renderer's already-culled commands at a fixed view.
		# Retain exactly that draw list, including padded degenerate faces.
		instance.ignore_occlusion_culling = true
		instance.custom_aabb = AABB(Vector3(-10000, -10000, -10000), Vector3(20000, 20000, 20000))
		root.add_child(instance)
		instance.owner = root
		triangles += ni / 3
	assert(triangles == int(manifest.totalTriangles))
	var packed := PackedScene.new()
	packed.pack(root)
	assert(ResourceSaver.save(packed, "res://data/captured.scn") == OK)
	print("MATCHED_LOD_BAKE_PASS draws=", manifest.draws.size(), " triangles=", triangles)
	root.free()
	quit()
