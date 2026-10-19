import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { build, transformSync } from 'esbuild'

const dir = new URL('../../src/features/hubspotToAlbi/', import.meta.url)

// A named component double: rendered as a node carrying its props, never called.
export function stub(name) {
  const fn = { [name]: function () { return null } }[name]
  fn.stub = true
  return fn
}

// Runs a real component file with its imports replaced by `bindings`. Hooks keep state across renders,
// effects run after each render, timers are manual, and hook-free local components render inline.
export async function mountComponent(file, { bindings = {}, props = {}, context = {}, storage: seed = {} } = {}) {
  const source = await readFile(new URL(file, dir), 'utf8')
  const name = file.replace(/\.jsx$/, '')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
    .replace('export default function', 'function').replace(/^export (?=const|function)/gm, ''),
  { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  const slots = [], effects = [], pending = [], listeners = {}, storage = new Map(Object.entries(seed)), clipboard = []
  let index = 0, tree, dirty = true, ids = 0, timerId = 0, currentProps = props
  const timers = new Map()
  const useState = initial => { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }] }
  const useRef = initial => { const slot = index++; return slots[slot] ??= { current: initial } }
  const useEffect = (run, deps) => { const slot = index++, prior = effects[slot]
    if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) pending.push(() => { prior?.cleanup?.(); effects[slot] = { deps, cleanup: run() } }) }
  const useCallback = (callback, deps) => { const ref = useRef(); if (!ref.current || deps.some((value, i) => !Object.is(value, ref.current.deps[i]))) ref.current = { callback, deps }; return ref.current.callback }
  const h = (type, props, ...children) => {
    const all = children.flat(Infinity)
    if (typeof type === 'function' && !type.stub) return type({ ...(props ?? {}), children: all })
    return { type: typeof type === 'function' ? type.name : type, props: props ?? {}, children: all }
  }
  const window = { addEventListener: (type, fn) => { (listeners[type] ??= new Set()).add(fn) }, removeEventListener: (type, fn) => { listeners[type]?.delete(fn) } }
  // ResolutionBar's shared class names and key badge, which every workspace component imports.
  const sandbox = { btn: 'btn', primary: 'primary', Kbd: stub('Kbd'), ...bindings, h, Fragment: 'fragment', useState, useRef, useEffect, useCallback, useMemo: callback => callback(),
    useOutletContext: () => context, AbortController, Intl, Date, Set, Map, Object, Array, JSON, Math, Number, String, Promise, URLSearchParams,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => { timers.delete(id) },
    window, document: { activeElement: null }, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    navigator: { clipboard: { writeText: value => { clipboard.push(value); return Promise.resolve() } } },
    IntersectionObserver: undefined }
  const component = vm.runInNewContext(`${code}\n${name}`, sandbox)
  async function flush() {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (dirty) { dirty = false; index = 0; tree = component(currentProps); while (pending.length) pending.shift()() }
      await Promise.resolve(); await Promise.resolve()
    }
    return tree
  }
  await flush()
  const nodes = (root = tree) => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }; walk(root); return all }
  const flat = textOf
  return { flush, nodes, timers, listeners, storage, clipboard, context,
    text: () => flat(tree), json: () => JSON.stringify(tree),
    rerender: next => { if (next) currentProps = { ...currentProps, ...next }; dirty = true; return flush() },
    tick: async () => { const due = [...timers.values()]; timers.clear(); due.forEach(callback => callback()); return flush() },
    find: (type, label) => nodes().find(node => node.type === type && (label === undefined || flat(node).includes(label) || JSON.stringify(node.children).includes(label))),
    all: type => nodes().filter(node => node.type === type),
    unmount: () => effects.forEach(effect => effect?.cleanup?.()) }
}

export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

export function textOf(node) {
  return Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? (node.children ?? []).map(textOf).join('')
    : node === null || node === undefined || typeof node === 'boolean' ? '' : String(node)
}
export function nodesOf(root) {
  const all = []; const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }
  walk(root); return all
}

// The real component bundled with its real imports and the real React, for static markup.
export async function loadComponent(file) {
  const result = await build({ entryPoints: [new URL(file, dir).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent' })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), Intl, Date, Object, Set, Map, navigator: {} })
  return module.exports.default
}
