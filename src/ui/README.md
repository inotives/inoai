# inoai UI

The UI is a separate product surface. Page modules, UI-only shared modules,
API modules (the read model, Task writes per ADR 0026, and role equip and
unequip writes per ADR 0031), and UI tests belong under this root.

The read model also reads the runtime home's `connections.json`, read-only
(ADR 0032). UI data carries only each connection's name, type, allow list,
and last status. It never carries `command`, `args`, `url`, `headers`, or
`env`, never reads `.env`, and the UI never writes `connections.json`.
