extends Node3D
var manifest: Dictionary
var camera: Camera3D
var label: Label
var measuring := false
var started := 0
var previous := 0
var frames: Array[float] = []
var unfocused := 0
var max_triangles := 0
var min_triangles := 2147483647
var max_draws := 0
var scale_value := 1
var result := "user://matched-lod.json"
var source_hash := ""

func _ready() -> void:
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 120
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--scale="): scale_value = int(arg.trim_prefix("--scale="))
		if arg.begins_with("--result="): result = arg.trim_prefix("--result=")
	get_window().content_scale_size = Vector2i(1280, 720) * scale_value
	get_window().content_scale_mode = Window.CONTENT_SCALE_MODE_VIEWPORT
	get_window().content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP
	var bytes := FileAccess.get_file_as_bytes("res://data/manifest.json")
	var hashing := HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(bytes)
	source_hash = hashing.finish().hex_encode()
	manifest = JSON.parse_string(bytes.get_string_from_utf8())
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(18.0 / 255, 24.0 / 255, 32.0 / 255)
	env.environment.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	add_child(env)
	add_child(load("res://data/captured.scn").instantiate())
	camera = Camera3D.new()
	camera.fov = manifest.fov
	camera.near = manifest.near
	camera.far = manifest.far
	camera.position = Vector3(manifest.cameraPosition[0], manifest.cameraPosition[1], manifest.cameraPosition[2])
	camera.quaternion = Quaternion(manifest.cameraQuaternion[0], manifest.cameraQuaternion[1], manifest.cameraQuaternion[2], manifest.cameraQuaternion[3])
	camera.current = true
	add_child(camera)
	var canvas := CanvasLayer.new()
	add_child(canvas)
	label = Label.new()
	label.position = Vector2(16, 16)
	label.text = "MATCHED WEB LOD / %d triangles\nF9: 8 s warm-up + 24 s sample\nF6: 720p / 1440p · Escape: release mouse" % manifest.totalTriangles
	canvas.add_child(label)
	DisplayServer.window_set_title("Copper · identical Web LOD · %dp" % (720 * scale_value))
	print("MATCHED_LOD_READY ", source_hash, " triangles=", manifest.totalTriangles)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_F9 and not measuring:
			frames.clear()
			unfocused = 0
			max_triangles = 0
			min_triangles = 2147483647
			max_draws = 0
			label.visible = false
			started = Time.get_ticks_usec()
			previous = started
			measuring = true
		if event.keycode == KEY_F6 and not measuring:
			scale_value = 3 - scale_value
			get_window().content_scale_size = Vector2i(1280, 720) * scale_value
			DisplayServer.window_set_title("Copper · identical Web LOD · %dp" % (720 * scale_value))

func _process(_delta: float) -> void:
	if not measuring: return
	var now := Time.get_ticks_usec()
	var elapsed := (now - started) / 1000000.0
	var ms := (now - previous) / 1000.0
	previous = now
	if elapsed >= 8:
		frames.append(ms)
		if not get_window().has_focus(): unfocused += 1
		var primitives := int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME))
		min_triangles = mini(min_triangles, primitives)
		max_triangles = maxi(max_triangles, primitives)
		max_draws = maxi(max_draws, int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)))
	if elapsed >= 32: finish()

func summarize() -> Dictionary:
	var ordered := frames.duplicate()
	ordered.sort()
	var sum := 0.0
	for n in frames: sum += n
	var tail := 0.0
	var count := maxi(1, int(ceil(frames.size() * 0.01)))
	for i in range(ordered.size() - count, ordered.size()): tail += ordered[i]
	return {"count": frames.size(), "mean": sum / frames.size(), "p50": ordered[int((ordered.size() - 1) * .5)], "p95": ordered[int((ordered.size() - 1) * .95)], "p99": ordered[int((ordered.size() - 1) * .99)], "max": ordered.back(), "slowestOnePercentMean": tail / count}

func finish() -> void:
	measuring = false
	var stats := summarize()
	var output := {"mode": "matched-lod-static", "backend": "Godot Metal / identical Web geometry", "world": manifest.world, "seed": manifest.seed,
		"manifestSha256": source_hash, "resolution": [1280 * scale_value, 720 * scale_value], "warmupSeconds": 8, "durationSeconds": 24,
		"frameMs": stats, "fps": 1000.0 / stats.mean, "onePercentLowFps": 1000.0 / stats.slowestOnePercentMean,
		"unfocusedFrames": unfocused, "maxDrawCalls": max_draws, "minPrimitives": min_triangles, "maxPrimitives": max_triangles,
		"expectedTriangles": manifest.totalTriangles, "rawFrameMs": frames, "utc": Time.get_datetime_string_from_system(true),
		"fpsLimit": 120, "msaa": 4, "debugBuild": OS.is_debug_build(), "frameMetric": "monotonic process-frame intervals", "vsync": false}
	DirAccess.make_dir_recursive_absolute(result.get_base_dir())
	FileAccess.open(result, FileAccess.WRITE).store_string(JSON.stringify(output, "\t"))
	get_viewport().get_texture().get_image().save_png(result.trim_suffix(".json") + ".png")
	label.visible = true
	label.text = "%0.2f FPS · p95 %0.2f ms\n%d triangles / expected %d · unfocused %d\nF9 repeat · F6 720p / 1440p" % [output.fps, stats.p95, max_triangles, manifest.totalTriangles, unfocused]
	print("MATCHED_LOD_COMPLETE ", result, " ", output.fps)
