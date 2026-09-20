/** Wrangler compiles imported `.wasm` files and exposes them as WebAssembly modules. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Wrangler imports checked-in `.txt` files as strings for in-Worker compiler inputs. */
declare module "*.txt" {
  const text: string;
  export default text;
}
