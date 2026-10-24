extends Node3D

const Torus = preload("res://scripts/torus.gd")
const Stream = preload("res://scripts/world_stream.gd")

const WARMUP := 8.0
const DURATION := 24.0
const SPEED := 40.0
const OVERVIEW_RADIUS := 4800.0
const OVERVIEW_HEIGHT := 3800.0
const OVERVIEW_TARGET := Vector3(0, -400, 0)
var world_stream: Node3D
var logical_position := Vector3(8192.5, 180.0, 1164.0)
var overview := true
var near_yaw := 0.0
var near_pitch := -0.668
var benchmark_overview := false
var benchmark_waiting := false
var benchmark_requested_usec := 0
var initial_load_seconds := 0.0
var camera: Camera3D
var hud: Label
var yaw := 0.0
var pitch := 0.0
var measuring := false
var elapsed := 0.0
var frame_ms: Array[float] = []
var gpu_ms: Array[float] = []
var result_path := "user://benchmarks/godot-latest.json"
var quit_when_done := false
var mesh_manifest: Dictionary
var map_name := ""
var orbit_center := Vector3(8192.5, 180, 1134)
var orbit_target := Vector3(8192.5, 70, 1024.5)
var test_started := 0
var previous_frame_usec := 0
var draw_calls := 0
var primitives := 0
var hud_elapsed := 0.0
var window_lost_focus := false
var unfocused_frames := 0

func _ready() -> void:
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	get_window().content_scale_size = Vector2i(1280, 720)
	get_window().content_scale_mode = Window.CONTENT_SCALE_MODE_VIEWPORT
	get_window().content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP
	if not FileAccess.file_exists("res://baked/torus-far.scn"):
		push_error("Map missing: run ./prepare.sh before launching.")
		get_tree().quit(1)
		return
	mesh_manifest = JSON.parse_string(FileAccess.get_file_as_string("res://baked/torus-manifest.json"))
	map_name = String(mesh_manifest.world).replace("-", " ").capitalize()
	DisplayServer.window_set_title("Space · " + map_name + " · Godot + Voxel Tools")
	if mesh_manifest.world == "copper-metropolis":
		orbit_center = Vector3(8402, 240, 1234)
		orbit_target = Vector3(8200, 70, 1032)
	logical_position = orbit_center + Vector3(0, 0, 30)
	var initial_basis := Basis.looking_at(orbit_target - logical_position)
	near_yaw = initial_basis.get_euler().y
	near_pitch = initial_basis.get_euler().x
	world_stream = Stream.new()
	add_child(world_stream)
	camera = Camera3D.new()
	camera.fov = 70.0
	camera.near = 0.1
	camera.far = 16000.0
	add_child(camera)
	set_overview(true)
	camera.current = true
	RenderingServer.viewport_set_measure_render_time(get_viewport().get_viewport_rid(), true)
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(20, 16)
	hud.add_theme_font_size_override("font_size", 17)
	hud.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.8))
	hud.add_theme_constant_override("shadow_offset_x", 1)
	hud.add_theme_constant_override("shadow_offset_y", 1)
	layer.add_child(hud)
	update_hud()
	for arg in OS.get_cmdline_user_args():
		if arg == "--near":
			set_overview(false)
		if arg.begins_with("--result="):
			result_path = arg.trim_prefix("--result=")
		if arg == "--quit-after-benchmark":
			quit_when_done = true
	if "--benchmark" in OS.get_cmdline_user_args():
		start_benchmark()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_ESCAPE:
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		if event.keycode == KEY_F9 and not measuring:
			start_benchmark()
		if event.keycode == KEY_F2 and not measuring:
			set_overview(not overview)
	if measuring:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		yaw -= event.relative.x * 0.002
		pitch = clampf(pitch - event.relative.y * 0.002, -1.5, 1.5)
		update_camera()

func set_overview(enabled: bool) -> void:
	if enabled:
		if not overview:
			near_yaw = yaw
			near_pitch = pitch
		overview = true
		camera.position = Vector3(0, OVERVIEW_HEIGHT, OVERVIEW_RADIUS)
		camera.look_at(OVERVIEW_TARGET)
		yaw = camera.rotation.y
		pitch = camera.rotation.x
	else:
		overview = false
		yaw = near_yaw
		pitch = near_pitch
		update_camera()
	world_stream.set_view(logical_position, overview)

func update_camera() -> void:
	var local_basis := Basis.from_euler(Vector3(pitch, yaw, 0))
	if overview:
		camera.basis = local_basis
	else:
		camera.position = Torus.bend(logical_position)
		camera.basis = Torus.frame(logical_position) * local_basis

func _process(delta: float) -> void:
	if camera == null:
		return
	if measuring:
		var now := Time.get_ticks_usec()
		elapsed = (now - test_started) / 1000000.0
		if benchmark_waiting: elapsed = 0.0
		var wall_frame_ms := (now - previous_frame_usec) / 1000.0
		previous_frame_usec = now
		var t := maxf(0.0, elapsed - WARMUP)
		if benchmark_overview:
			camera.position = Vector3(OVERVIEW_RADIUS * sin(t * TAU / 24.0), OVERVIEW_HEIGHT, OVERVIEW_RADIUS * cos(t * TAU / 24.0))
			camera.look_at(OVERVIEW_TARGET)
		else:
			logical_position = orbit_center + Vector3(60.0 * sin(t * TAU / 24.0), 15.0 * sin(t * TAU / 16.0), 30.0 * cos(t * TAU / 24.0))
			camera.position = Torus.bend(logical_position)
			camera.basis = Torus.frame(logical_position) * Basis.looking_at(orbit_target - logical_position)
		world_stream.set_view(logical_position, overview)
		if benchmark_waiting:
			var state: Dictionary = world_stream.statistics()
			if benchmark_overview or (state.pendingJobs == 0 and state.queuedJobs == 0 and state.solidSectors > 0 and state.microSectors > 0):
				initial_load_seconds = (now - benchmark_requested_usec) / 1000000.0
				benchmark_waiting = false
				test_started = now
				previous_frame_usec = now
				window_lost_focus = false
				print("BENCHMARK_READY after ", initial_load_seconds, " s; starting warm-up.")
			elif now - benchmark_requested_usec > 90000000:
				push_error("Nearby terrain failed to become ready within 90 seconds.")
				get_tree().quit(1)
			return
		if elapsed >= WARMUP:
			frame_ms.append(wall_frame_ms)
			if not DisplayServer.window_is_focused():
				unfocused_frames += 1
			var gpu := RenderingServer.viewport_get_measured_render_time_gpu(get_viewport().get_viewport_rid())
			if gpu > 0:
				gpu_ms.append(gpu)
			draw_calls = maxi(draw_calls, int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)))
			primitives = maxi(primitives, int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)))
		if elapsed >= WARMUP + DURATION:
			finish_benchmark()
		return
	var move := Vector3.ZERO
	if Input.is_physical_key_pressed(KEY_W): move.z -= 1
	if Input.is_physical_key_pressed(KEY_S): move.z += 1
	if Input.is_physical_key_pressed(KEY_A): move.x -= 1
	if Input.is_physical_key_pressed(KEY_D): move.x += 1
	var vertical := 0.0
	if Input.is_physical_key_pressed(KEY_SPACE) or Input.is_physical_key_pressed(KEY_E): vertical += 1
	if Input.is_physical_key_pressed(KEY_Q) or Input.is_physical_key_pressed(KEY_CTRL): vertical -= 1
	var direction := Basis.from_euler(Vector3(pitch, yaw, 0)) * move
	direction.y += vertical
	if direction.length_squared() > 0:
		var speed := (500.0 if overview else SPEED) * (5.0 if Input.is_physical_key_pressed(KEY_SHIFT) else 1.0)
		if overview:
			camera.position += direction.normalized() * speed * delta
		else:
			logical_position = Torus.wrapped(logical_position + direction.normalized() * speed * delta)
		update_camera()
	world_stream.set_view(logical_position, overview)
	hud_elapsed += delta
	if hud_elapsed >= 0.25:
		hud_elapsed = 0.0
		update_hud()

func update_hud() -> void:
	var stats: Dictionary = world_stream.statistics()
	hud.text = "%s  /  TORUS TOUR\nGodot + Voxel Tools  ·  %d FPS\n\nClick to look · WASD fly · Space / Q up / down\nShift faster · Esc release mouse · F9 benchmark\nF2: %s\n\n16,384 × 2,048 m closed world · seed %d\nLOD: 8 m far / 1 m near / 1/8 m micro\nNear sectors: %d · Micro: %d · Loading: %d\nSingle player · read-only" % [map_name.to_upper(), Engine.get_frames_per_second(), "Enter terrain" if overview else "Whole-ring overview", mesh_manifest.seed, stats.solidSectors, stats.microSectors, stats.pendingJobs + stats.queuedJobs]

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_WINDOW_FOCUS_OUT and measuring and (Time.get_ticks_usec() - test_started) / 1000000.0 >= WARMUP:
		window_lost_focus = true

func start_benchmark() -> void:
	measuring = true
	benchmark_overview = overview
	benchmark_waiting = true
	elapsed = 0.0
	frame_ms.clear()
	gpu_ms.clear()
	window_lost_focus = false
	unfocused_frames = 0
	draw_calls = 0
	primitives = 0
	hud.visible = true
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	test_started = Time.get_ticks_usec()
	benchmark_requested_usec = test_started
	previous_frame_usec = test_started
	print("BENCHMARK_START: 8 s warm-up + 24 s fixed camera path; keep window focused.")

func summarize(values: Array[float]) -> Dictionary:
	if values.is_empty(): return {"available": false}
	var sorted := values.duplicate()
	sorted.sort()
	var sum := 0.0
	for value in values: sum += value
	var tail := 0.0
	var tail_count := maxi(1, int(ceil(sorted.size() * 0.01)))
	for i in range(sorted.size() - tail_count, sorted.size()): tail += sorted[i]
	return {"available": true, "count": values.size(), "mean": sum / values.size(),
		"p50": sorted[int((sorted.size() - 1) * 0.5)], "p95": sorted[int((sorted.size() - 1) * 0.95)],
		"p99": sorted[int((sorted.size() - 1) * 0.99)], "max": sorted.back(), "slowestOnePercentMean": tail / tail_count}

func finish_benchmark() -> void:
	measuring = false
	var stats := summarize(frame_ms)
	var result := {"backend": "Godot native Metal", "engine": Engine.get_version_info().string,
		"world": mesh_manifest.world, "seed": mesh_manifest.seed,
		"device": RenderingServer.get_video_adapter_name(), "os": OS.get_name(), "debugBuild": OS.is_debug_build(),
		"utc": Time.get_datetime_string_from_system(true), "resolution": [get_viewport().get_texture().get_width(), get_viewport().get_texture().get_height()],
		"warmupSeconds": WARMUP, "durationSeconds": DURATION, "fov": camera.fov,
		"sourceSha256": mesh_manifest.sourceSha256, "farSectors": mesh_manifest.sectors, "farTriangles": mesh_manifest.farTriangles,
		"hudVisible": true, "lighting": "vertex lighting", "projection": "closed conformal torus", "vsync": false,
		"view": "whole ring" if benchmark_overview else "terrain orbit", "streaming": world_stream.statistics(),
		"orbitCenter": [orbit_center.x, orbit_center.y, orbit_center.z], "orbitTarget": [orbit_target.x, orbit_target.y, orbit_target.z],
		"initialLoadSeconds": initial_load_seconds,
		"windowLostFocus": window_lost_focus, "unfocusedFrames": unfocused_frames, "frameMetric": "monotonic wall-clock frame intervals; not smoothed simulation delta", "frameMs": stats,
		"viewportGpuMs": summarize(gpu_ms), "fps": 1000.0 / stats.mean,
		"onePercentLowFps": 1000.0 / stats.slowestOnePercentMean,
		"maxDrawCalls": draw_calls, "maxPrimitives": primitives,
		"staticMemoryBytes": Performance.get_monitor(Performance.MEMORY_STATIC), "rawFrameMs": frame_ms}
	DirAccess.make_dir_recursive_absolute(result_path.get_base_dir())
	var file := FileAccess.open(result_path, FileAccess.WRITE)
	if file == null:
		push_error("Could not save benchmark: " + result_path)
	else:
		file.store_string(JSON.stringify(result, "\t"))
		file.close()
	get_viewport().get_texture().get_image().save_png(result_path.trim_suffix(".json") + ".png")
	print("BENCHMARK_COMPLETE ", result_path, " FPS=", result.fps, " p95=", stats.p95, " focus_lost=", window_lost_focus)
	hud.visible = true
	var local_basis := camera.basis if overview else Torus.frame(logical_position).inverse() * camera.basis
	yaw = local_basis.get_euler().y
	pitch = local_basis.get_euler().x
	update_hud()
	if quit_when_done:
		get_tree().quit()
