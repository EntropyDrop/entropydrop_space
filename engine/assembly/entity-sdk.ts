// AssemblyScript SDK for entity code. This file is compiled for WASM, not JavaScript.
@external("entity", "get") declare function read(h: i32, key: string): i32;
@external("entity", "number") declare function numberValue(h: i32): f64;
@external("entity", "boolean") declare function boolValue(h: i32): bool;
@external("entity", "stringLength") declare function stringLength(h: i32): i32;
@external("entity", "stringCopy") declare function stringCopy(h: i32, ptr: usize): void;
@external("entity", "make") declare function make(kind: i32, n: f64, s: string): i32;
@external("entity", "set") declare function write(h: i32, key: string, value: i32): void;
@external("entity", "call") declare function invoke(h: i32, name: string, args: i32): i32;

/** JSON-compatible data. Snapshots are read-only; object()/array() and State are writable. */
export class Value {
  constructor(public handle: i32 = 0) {}
  get apiVersion(): i32 { return 3; }
  static object(): Value { return new Value(make(0, 0, "")); }
  static array(): Value { return new Value(make(1, 0, "")); }
  static number(n: f64): Value { return new Value(make(2, n, "")); }
  static string(s: string): Value { return new Value(make(3, 0, s)); }
  static boolean(b: bool): Value { return new Value(make(4, b ? 1 : 0, "")); }
  static vector(v: f64[]): Value {
    const out = Value.array();
    for (let i = 0; i < v.length; i++) out.push(Value.number(v[i]));
    return out;
  }
  get isNull(): bool { return this.handle == 0; }
  get length(): i32 { return <i32>this.getNumber("length"); }
  get(key: string): Value { return new Value(read(this.handle, key)); }
  at(index: i32): Value { return this.get(index.toString()); }
  asNumber(): f64 { return numberValue(this.handle); }
  asBoolean(): bool { return boolValue(this.handle); }
  asString(): string {
    const size = stringLength(this.handle);
    const result = changetype<string>(__new(<usize>size * 2, idof<string>()));
    stringCopy(this.handle, changetype<usize>(result));
    return result;
  }
  asVector(): f64[] {
    const out = new Array<f64>(this.length);
    for (let i = 0; i < out.length; i++) out[i] = this.at(i).asNumber();
    return out;
  }
  getNumber(key: string, fallback: f64 = 0): f64 { const v = this.get(key); return v.isNull ? fallback : v.asNumber(); }
  getString(key: string, fallback: string = ""): string { const v = this.get(key); return v.isNull ? fallback : v.asString(); }
  getBoolean(key: string, fallback: bool = false): bool { const v = this.get(key); return v.isNull ? fallback : v.asBoolean(); }
  set(key: string, value: Value): Value { write(this.handle, key, value.handle); return this; }
  setNumber(key: string, n: f64): Value { return this.set(key, Value.number(n)); }
  setString(key: string, s: string): Value { return this.set(key, Value.string(s)); }
  setBoolean(key: string, b: bool): Value { return this.set(key, Value.boolean(b)); }
  setVector(key: string, v: f64[]): Value { return this.set(key, Value.vector(v)); }
  push(value: Value): Value { return this.set(this.length.toString(), value); }
  call(name: string, args: Value = Value.array()): Value { return new Value(invoke(this.handle, name, args.handle)); }
}
export class State extends Value {}
export class Input extends Value {
  down(key: string): bool { return this.call("down", args1(Value.string(key))).asBoolean(); }
  pressed(key: string): bool { return this.call("pressed", args1(Value.string(key))).asBoolean(); }
  released(key: string): bool { return this.call("released", args1(Value.string(key))).asBoolean(); }
}
function args1(a: Value): Value { return Value.array().push(a); }
function args2(a: Value, b: Value): Value { return args1(a).push(b); }
function args3(a: Value, b: Value, c: Value): Value { return args2(a, b).push(c); }
export class Body extends Value {
  getType(): string { return this.call("getType").asString(); }
  setType(type: string): Value { return this.call("setType", args1(Value.string(type))); }
  getMass(): f64 { return this.call("getMass").asNumber(); }
  setMass(mass: f64): Value { return this.call("setMass", args1(Value.number(mass))); }
  getMaterial(): Value { return this.call("getMaterial"); }
  setMaterial(material: Value): Value { return this.call("setMaterial", args1(material)); }
  getGravityEnabled(): bool { return this.call("getGravityEnabled").asBoolean(); }
  setGravityEnabled(enabled: bool): Value { return this.call("setGravityEnabled", args1(Value.boolean(enabled))); }
  getCollisionEnabled(): bool { return this.call("getCollisionEnabled").asBoolean(); }
  setCollisionEnabled(enabled: bool): Value { return this.call("setCollisionEnabled", args1(Value.boolean(enabled))); }
  getVelocity(): f64[] { return this.call("getVelocity").asVector(); }
  getAngularVelocity(): f64[] { return this.call("getAngularVelocity").asVector(); }
  applyForce(v: f64[]): bool { return this.call("applyForce", args1(Value.vector(v))).asBoolean(); }
  applyLocalForce(v: f64[]): bool { return this.call("applyLocalForce", args1(Value.vector(v))).asBoolean(); }
  applyTorque(v: f64[]): bool { return this.call("applyTorque", args1(Value.vector(v))).asBoolean(); }
}
export class Api {
  constructor(public handle: i32 = 0) {}
  get apiVersion(): i32 { return 3; }
  call(name: string, args: Value = Value.array()): Value { return new Value(invoke(this.handle, name, args.handle)); }
}
export class Voxels extends Api {
  get(p: f64[]): Value { return this.call("get", args1(Value.vector(p))); }
  set(p: f64[], options: Value = Value.object()): Value { return this.call("set", args2(Value.vector(p), options)); }
  clear(p: f64[]): Value { return this.call("clear", args1(Value.vector(p))); }
  paint(p: f64[], options: Value = Value.object()): Value { return this.call("paint", args2(Value.vector(p), options)); }
  clearCell(p: f64[]): Value { return this.call("clearCell", args1(Value.vector(p))); }
  subdivide(p: f64[], offset: f64[] | null = null): Value { return this.call("subdivide", offset ? args2(Value.vector(p), Value.vector(offset)) : args1(Value.vector(p))); }
}
export class MicroVoxels extends Api {
  get(p: f64[], offset: f64[]): Value { return this.call("get", args2(Value.vector(p), Value.vector(offset))); }
  set(p: f64[], offset: f64[], options: Value = Value.object()): Value { return this.call("set", args3(Value.vector(p), Value.vector(offset), options)); }
  clear(p: f64[], offset: f64[]): Value { return this.call("clear", args2(Value.vector(p), Value.vector(offset))); }
  paint(p: f64[], offset: f64[], options: Value = Value.object()): Value { return this.call("paint", args3(Value.vector(p), Value.vector(offset), options)); }
}
export class Constraints extends Value {
  all(): Value { return this.call("all"); }
  create(options: Value): Value { return this.call("create", args1(options)); }
  remove(id: string): bool { return this.call("remove", args1(Value.string(id))).asBoolean(); }
}
export class Component extends Value {
  get id(): string { return this.getString("id"); }
  get parentId(): string { return this.getString("parentId"); }
  get state(): State { return new State(read(this.handle, "state")); }
  get body(): Body { return new Body(read(this.handle, "body")); }
  get constraints(): Constraints { return new Constraints(read(this.handle, "constraints")); }
  get voxels(): Voxels { return new Voxels(read(this.handle, "voxels")); }
  get microVoxels(): MicroVoxels { return new MicroVoxels(read(this.handle, "microVoxels")); }
  child(id: string): Component | null { const v = this.call("child", args1(Value.string(id))); return v.isNull ? null : new Component(v.handle); }
  children(): Component[] {
    const v = this.call("children"); const out = new Array<Component>();
    for (let i = 0; i < v.length; i++) out.push(new Component(v.at(i).handle));
    return out;
  }
  stop(): void { this.call("stop"); }
  getBounds(): Value { return this.call("getBounds"); }
  setSeats(seats: Value): void { this.call("setSeats", args1(seats)); }
  getSeats(): Value { return this.call("getSeats"); }
  setLocalSpin(axis: f64[], rpm: f64): void { this.call("setLocalSpin", args2(Value.vector(axis), Value.number(rpm))); }
  applyForceAt(force: f64[], point: f64[]): void { this.call("applyForceAt", args2(Value.vector(force), Value.vector(point))); }
  localToWorldDirection(v: f64[]): f64[] { return this.call("localToWorldDirection", args1(Value.vector(v))).asVector(); }
  getWorldPosition(): f64[] { return this.call("getWorldPosition").asVector(); }
  getWorldRotation(): f64[] { return this.call("getWorldRotation").asVector(); }
  getPivot(): f64[] { return this.call("getPivot").asVector(); }
  getLocalPosition(): f64[] { return this.call("getLocalPosition").asVector(); }
  getLocalRotation(): f64[] { return this.call("getLocalRotation").asVector(); }
  applyThrust(v: f64[]): void { this.call("applyThrust", args1(Value.vector(v))); }
  applyLocalThrust(v: f64[]): void { this.call("applyLocalThrust", args1(Value.vector(v))); }
  applyForce(v: f64[]): void { this.call("applyForce", args1(Value.vector(v))); }
  applyLocalForce(v: f64[]): void { this.call("applyLocalForce", args1(Value.vector(v))); }
  applyTorque(v: f64[]): void { this.call("applyTorque", args1(Value.vector(v))); }
  setLocalPosition(v: f64[]): void { this.call("setLocalPosition", args1(Value.vector(v))); }
  setLocalRotation(v: f64[]): void { this.call("setLocalRotation", args1(Value.vector(v))); }
  setLocalEuler(v: f64[]): void { this.call("setLocalEuler", args1(Value.vector(v))); }
  setPivot(v: f64[]): void { this.call("setPivot", args1(Value.vector(v))); }
}
export class World extends Value {
  getInfo(): Value { return this.call("getInfo"); }
  get voxels(): Voxels { return new Voxels(read(this.handle, "voxels")); }
  get microVoxels(): MicroVoxels { return new MicroVoxels(read(this.handle, "microVoxels")); }
  entities(origin: f64[], radius: f64 = 16): Value { return this.call("entities", args2(Value.vector(origin), Value.number(radius))); }
  entity(id: string): Value { return this.get("entities").call("get", args1(Value.string(id))); }
  entitiesInChunk(id: string): Value { return this.get("entities").call("list", args1(Value.string(id))); }
  raycast(origin: f64[], direction: f64[], maxDistance: f64 = 24): Value { return this.raycastWithOptions(origin, direction, Value.number(maxDistance)); }
  raycastWithOptions(origin: f64[], direction: f64[], options: Value): Value { return this.call("raycast", args3(Value.vector(origin), Value.vector(direction), options)); }
}
export class Messages extends Value {
  get received(): Value { return this.get("received"); }
  send(target: string, type: string, payload: string): Value { return this.call("send", args3(Value.string(target), Value.string(type), Value.string(payload))); }
  sendBytes(target: string, type: string, payload: Uint8Array): Value {
    const bytes = Value.array();
    for (let i = 0; i < payload.length; i++) bytes.push(Value.number(payload[i]));
    return this.call("send", args3(Value.string(target), Value.string(type), bytes).push(Value.string("protobuf")));
  }
}
export class CommandResults extends Value {
  result(id: string): Value { return this.call("get", args1(Value.string(id))); }
  all(): Value { return this.call("all"); }
}
export class Blocks extends Value {
  pressed(type: string = ""): bool { return this.call("pressed", type.length ? args1(Value.string(type)) : Value.array()).asBoolean(); }
  event(): Value { return this.call("event"); }
}
export class Selection extends Value {
  snapshot(): Value { return this.call("get"); }
  clear(): Value { return this.call("clear"); }
  cornerA(p: f64[], options: Value = Value.object()): Value { return this.call("cornerA", args2(Value.vector(p), options)); }
  cornerB(p: f64[], options: Value = Value.object()): Value { return this.call("cornerB", args2(Value.vector(p), options)); }
  box(a: f64[], b: f64[], options: Value = Value.object()): Value { return this.call("box", args3(Value.vector(a), Value.vector(b), options)); }
  cells(cells: Value): Value { return this.call("cells", args1(cells)); }
  toggle(p: f64[]): Value { return this.call("toggle", args1(Value.vector(p))); }
  entity(id: string, node: string = ""): Value { return this.call("entity", args2(Value.string(id), node.length ? Value.string(node) : new Value())); }
  entityBox(id: string, node: string, a: f64[], b: f64[], space: string = "local"): Value { return this.call("entityBox", args2(Value.string(id), Value.string(node)).push(Value.vector(a)).push(Value.vector(b)).push(Value.string(space))); }
  delete(): Value { return this.call("delete"); }
  assemble(mode: string = "programmable", options: Value = Value.object()): Value { return this.call("assemble", args2(Value.string(mode), options)); }
  createChild(id: string = ""): Value { return this.call("createChild", args1(Value.string(id))); }
}
export class Context extends Value {
  get root(): Component { return new Component(read(this.handle, "root")); }
  get input(): Input { return new Input(read(this.handle, "input")); }
  get world(): World { return new World(read(this.handle, "world")); }
  get messages(): Messages { return new Messages(read(this.handle, "messages")); }
  get commands(): CommandResults { return new CommandResults(read(this.handle, "commands")); }
  get blocks(): Blocks { return new Blocks(read(this.handle, "blocks")); }
  get selection(): Selection { return new Selection(read(this.handle, "selection")); }
  log(message: string): void { this.call("log", args1(Value.string(message))); }
  get time(): f64 { return this.getNumber("time"); }
  get deltaTime(): f64 { return this.getNumber("deltaTime"); }
  get tick(): f64 { return this.getNumber("tick"); }
  get groundDistance(): f64 { return this.getNumber("groundDistance"); }
  get mass(): f64 { return this.getNumber("mass"); }
  get entityId(): string { return this.getString("entityId"); }
  get bodyType(): string { return this.getString("bodyType"); }
  get isOnGround(): bool { return this.getBoolean("isOnGround"); }
  get position(): f64[] { return this.get("position").asVector(); }
  get velocity(): f64[] { return this.get("velocity").asVector(); }
  get rotation(): f64[] { return this.get("rotation").asVector(); }
  get angularVelocity(): f64[] { return this.get("angularVelocity").asVector(); }
  get gravity(): f64[] { return this.get("gravity").asVector(); }
  get players(): Value { return this.get("players"); }
  get driver(): Value { return this.get("driver"); }
  get contacts(): Value { return this.get("contacts"); }
  get limits(): Value { return this.get("limits"); }
}
