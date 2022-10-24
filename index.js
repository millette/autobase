const ReadyResource = require('ready-resource')

const Keychain = require('keypear')
const safetyCatch = require('safety-catch')
const streamx = require('streamx')
const mutexify = require('mutexify/promise')
const c = require('compact-encoding')
const b = require('b4a')

const LinearizedView = require('./lib/view')
const MemberBatch = require('./lib/batch')
const KeyCompressor = require('./lib/compression')
const Output = require('./lib/output')
const { length } = require('./lib/clock')
const { InputNode, OutputNode } = require('./lib/nodes')
const { Node: NodeSchema, decodeHeader } = require('./lib/nodes/messages')

const INPUT_PROTOCOL = '@autobase/input/v1'
const OUTPUT_PROTOCOL = '@autobase/output/v1'

const FORCE_NON_SPARSE = +process.env['NON_SPARSE'] // eslint-disable-line

class Autobase extends ReadyResource {
  constructor (corestore, keychain, opts = {}) {
    super()
    const { inputs, outputs, autostart, apply, open, views, version, unwrap, eagerUpdate, sparse, localInput, persist } = opts

    this.corestore = corestore
    this.keychain = Keychain.from(keychain)

    this._inputs = inputs || []
    this._outputs = outputs || []
    this._inputsByKey = new Map()
    this._outputsByKey = new Map()
    this._keyCompressors = new Map()
    this._lock = mutexify()
    this._eagerUpdate = eagerUpdate !== false

    this._sparse = (sparse !== false) && (FORCE_NON_SPARSE !== 1)
    this._persist = persist !== false

    this._localInput = localInput
    this._outputsKeychain = this.keychain.sub(Autobase.OUTPUTS)

    this._batchId = 0
    this._loadingInputsCount = 0
    this._pendingUpdates = []

    this.view = null
    this._viewCount = views || 1
    this._viewVersion = version || 1
    if (apply || autostart) this.start({ apply, open, unwrap })

    this._onappend = () => {
      this.emit('append')
      this._onInputsChanged()
    }
  }

  get localInput () {
    return this._inputsByKey.get(b.toString(this.keychain.publicKey, 'hex'))
  }

  get localInputKey () {
    return this.keychain.publicKey
  }

  get localOutputKey () {
    return this._outputsKeychain.publicKey
  }

  get localOutputs () {
    const outputs = this._localOutputs()
    return outputs.map(o => o.core)
  }

  static getOutputKeys (keychain, n) {
    const keys = []
    for (let i = 0; i < n; i++) {
      keys.push(!i ? keychain.get() : keychain.get('' + i))
    }
    return keys
  }

  get isIndexing () {
    const outputs = this._localOutputs()
    return !!(outputs && outputs.length)
  }

  // Private Methods

  async _open () {
    await this.corestore.ready()
    if (this._localInput) this._addInput(this.keychain)
    for (const input of this._inputs) {
      this._addInput(input)
    }
    for (const output of this._outputs) {
      this._addOutput(output)
    }
    await Promise.all([
      ...[...this._inputsByKey.values()].map(i => i.ready()),
      ...[...this._outputsByKey.values()].flatMap(outputs => outputs.map(o => o.ready()))
    ])
  }

  _deriveOutputs (keychain) {
    keychain = this._toKeychain(keychain)
    const outputs = this._outputsByKey.get(b.toString(keychain.publicKey, 'hex'))
    const keypairs = Autobase.getOutputKeys(keychain, this._viewCount)
    for (let i = outputs.length; i < this._viewCount; i++) {
      outputs.push(new Output(i, this.corestore.get(keypairs[i])))
    }
  }

  _localOutputs () {
    return this._outputsByKey.get(b.toString(this.localOutputKey, 'hex'))
  }

  _toKeychain (keychain) {
    if (!b.isBuffer(keychain)) return keychain
    if (b.equals(keychain, this.keychain.publicKey)) return this.keychain
    if (b.equals(keychain, this._outputsKeychain.publicKey)) return this._outputsKeychain
    return this.keychain.checkout(keychain)
  }

  // Called by MemberBatch
  _addInput (keychain) {
    keychain = this._toKeychain(keychain)
    const id = b.toString(keychain.publicKey, 'hex')

    if (this._inputsByKey.has(id)) return

    // TODO: If we ever want the keypair instance to be a class, this will need updating
    const input = this.corestore.get({ ...keychain.get(), sparse: this._sparse })
    input.on('append', this._onappend)
    this._inputsByKey.set(id, input)

    this._onInputsChanged()

    return input
  }

  // Called by MemberBatch
  _addOutput (keychain) {
    keychain = this._toKeychain(keychain)
    const id = b.toString(keychain.publicKey, 'hex')

    const existing = this._outputsByKey.get(id)
    if (existing && existing.length === this._viewCount) return

    if (!existing) {
      this._outputsByKey.set(id, [])
    }
    this._deriveOutputs(keychain)

    return this._outputsByKey.get(id)
  }

  // Called by MemberBatch
  _removeInput (keychain) {
    keychain = this._toKeychain(keychain)

    const id = b.toString(keychain.publicKey, 'hex')
    if (!this._inputsByKey.has(id)) return

    const input = this._inputsByKey.get(id)
    input.removeListener('append', this._onappend)
    this._inputsByKey.delete(id)

    this._onInputsChanged()

    return () => input.close()
  }

  // Called by MemberBatch
  _removeOutput (keychain) {
    keychain = this._toKeychain(keychain)

    const id = b.toString(keychain.publicKey, 'hex')
    if (!this._outputsByKey.has(id)) return

    const outputs = this._outputsByKey.get(id)
    this._outputsByKey.delete(id)

    return () => Promise.all(outputs.map(o => o.close()))
  }

  _onInputsChanged () {
    if (this._eagerUpdate && this.view) {
      // Eagerly update the primary view if there's a local output
      // This will be debounced internally
      this._internalView.update().catch(safetyCatch)
    }
  }

  _getKeyCompressor (input) {
    let keyCompressor = this._keyCompressors.get(input)
    if (!keyCompressor) {
      keyCompressor = new KeyCompressor(input)
      this._keyCompressors.set(input, keyCompressor)
    }
    return keyCompressor
  }

  async _decompressClock (input, seq, clock, opts) {
    const keyCompressor = this._getKeyCompressor(input)
    return keyCompressor.decompress(clock, seq, opts)
  }

  async _compressClock (input, seq, clock, opts) {
    const keyCompressor = this._getKeyCompressor(input)
    return keyCompressor.compress(clock, seq, opts)
  }

  async _getInputNode (input, seq, opts) {
    if (seq < 0) return null
    if (b.isBuffer(input)) input = b.toString(input, 'hex')
    if (typeof input === 'string') {
      if (!this._inputsByKey.has(input)) return null
      input = this._inputsByKey.get(input)
    }

    const block = await input.get(seq, opts)
    if (!block && opts.wait === false) return null

    let decoded = null
    try {
      decoded = NodeSchema.decode({ start: 0, end: block.length, buffer: block })
    } catch (err) {
      return safetyCatch(err)
    }

    const node = new InputNode({ ...decoded, key: input.key, seq })

    if (opts && opts.loadBatchClock !== false) {
      if (node.batch[1] !== 0) {
        const batchEnd = await this._getInputNode(input, seq + node.batch[1], opts)
        node.clock = batchEnd.clock
      }
    }

    if (node.clock) {
      node.clock = await this._decompressClock(input, seq, decoded.clock, opts)
      if (node.seq > 0) node.clock.set(node.id, node.seq - 1)
      else node.clock.delete(node.id)
    }

    return node
  }

  _waitForInputs () {
    return new Promise(resolve => {
      this._pendingUpdates.push(resolve)
    })
  }

  // Public API

  get inputs () {
    return [...this._inputsByKey.values()]
  }

  get outputs () {
    return [...this._outputsByKey.values()]
  }

  get started () {
    return !!this.view
  }

  loadingInputs () {
    this._loadingInputsCount++
    return () => {
      if (--this._loadingInputsCount === 0) {
        for (const resolve of this._pendingUpdates) {
          resolve()
        }
      }
    }
  }

  start ({ version, views, open, apply, unwrap } = {}) {
    if (this.view) throw new Error('Start must only be called once')
    if (views) {
      this._viewCount = views
    }
    if (version) {
      this._viewVersion = version
    }
    for (const key of this._outputsByKey.keys()) {
      this._deriveOutputs(b.from(key, 'hex'))
    }
    const view = new LinearizedView(this, {
      header: { version: this._viewVersion, protocol: OUTPUT_PROTOCOL },
      writable: this._persist !== false,
      open,
      apply,
      unwrap
    })
    this._internalView = view
    this.view = view.userView.length === 1 ? view.userView[0] : view.userView
    return this.view
  }

  async heads (clock, opts) {
    if (!this.opened) await this.ready()
    clock = clock || await this.latest(opts)

    const headPromises = []
    for (const key of clock.keys()) {
      const input = this._inputsByKey.get(key)
      if (!input) return []
      headPromises.push(this._getInputNode(input, clock ? clock.get(key) : input.length - 1, opts))
    }

    return Promise.all(headPromises)
  }

  _loadClockNodes (clock) {
    return Promise.all([...clock].map(([id, seq]) => {
      return this._getInputNode(id, seq, { loadBatchClock: false }).then(node => [id, node])
    }))
  }

  _getLatestSparseClock (inputs) {
    if (!inputs) inputs = this.inputs
    if (!Array.isArray(inputs)) inputs = [inputs]

    const clock = new Map()
    for (const input of inputs) {
      const id = b.toString(input.key, 'hex')
      if (!this._inputsByKey.has(id)) throw new Error('Hypercore is not an input of the Autobase')
      if (input.length === 0) continue
      clock.set(id, input.length - 1)
    }

    return clock
  }

  async _getLatestNonSparseClock (clock) {
    const allHeads = await this._loadClockNodes(clock)
    const availableClock = new Map()

    // If the latest node in an input is in the middle of a batch, shift the clock back to before that batch.
    let wasAdjusted = false
    for (const [id, node] of allHeads) {
      if (node.batch[1] === 0) {
        availableClock.set(id, node.seq)
      } else {
        wasAdjusted = true
        const adjusted = node.seq - node.batch[0] - 1
        if (adjusted < 0) continue
        availableClock.set(id, adjusted)
      }
    }

    // If any head links to a node that's after a current head, then it can't be satisfied.
    // If not satisfiable, find the latest satisfiable head for that input.
    const heads = wasAdjusted ? await this._loadClockNodes(availableClock) : allHeads
    while (heads.length) {
      const [id, node] = heads[heads.length - 1]
      let satisfied = true
      let available = true
      for (const [clockId, clockSeq] of node.clock) {
        if (availableClock.has(clockId) && clockSeq <= availableClock.get(clockId)) continue
        satisfied = false
        const next = node.seq - node.batch[0] - 1
        if (next < 0) {
          available = false
          break
        }
        heads[heads.length - 1][1] = await this._getInputNode(id, next, { loadBatchClock: false })
        break
      }
      if (satisfied) {
        availableClock.set(id, node.seq)
        heads.pop()
      } else if (!available) {
        availableClock.delete(id)
        heads.pop()
      }
    }

    return availableClock
  }

  async latest (opts = {}) {
    if (!this.opened) await this._opening
    await Promise.all(this.inputs.map(i => i.update()))
    const inputs = opts.fork !== true ? this.inputs : [this.localInput]
    const sparseClock = this._getLatestSparseClock(inputs)
    if (this._sparse) return sparseClock
    return this._getLatestNonSparseClock(sparseClock)
  }

  memberBatch () {
    return new MemberBatch(this)
  }

  async addInput (keychain, opts) {
    const batch = new MemberBatch(this)
    batch.addInput(keychain, opts)
    if (opts && opts.output) {
      batch.addOutput(keychain.sub(Autobase.OUTPUTS))
    }
    return batch.commit()
  }

  async removeInput (keychain, opts) {
    const batch = new MemberBatch(this)
    batch.removeInput(keychain, opts)
    if (opts && opts.output) {
      batch.removeOutput(keychain.sub(Autobase.OUTPUTS))
    }
    return batch.commit()
  }

  async addOutput (keychain, opts) {
    const batch = new MemberBatch(this)
    batch.addOutput(keychain, opts)
    return batch.commit()
  }

  async removeOutput (keychain, opts) {
    const batch = new MemberBatch(this)
    batch.removeOutput(keychain, opts)
    return batch.commit()
  }

  createCausalStream (opts = {}) {
    const self = this
    let heads = null
    let batchIndex = null
    let batchClock = null

    return new streamx.Readable({ open, read })

    function open (cb) {
      self.heads(opts.clock, opts)
        .then(h => { heads = h })
        .then(() => cb(null), err => cb(err))
    }

    function read (cb) {
      let node = null
      let headIndex = null
      let clock = null

      if (batchIndex !== null) {
        node = heads[batchIndex]
        headIndex = batchIndex
        clock = batchClock
        if (node.batch[0] === 0) {
          batchIndex = null
          batchClock = null
        }
      } else {
        const info = forkInfo(heads)
        if (!info.forks.length) {
          this.push(null)
          return cb(null)
        }
        node = info.forks[info.smallest]
        headIndex = heads.indexOf(node)
        clock = info.clock
      }

      if (node.batch[1] === 0 && node.batch[0] > 0) {
        batchIndex = headIndex
        batchClock = clock
      }

      this.push(new OutputNode({ ...node, change: node.key, clock, operations: length(clock) }, null))

      // TODO: When reading a batch node, parallel download them all (use batch[0])
      // TODO: Make a causal stream extension for faster reads

      if (node.seq === 0) {
        heads.splice(headIndex, 1)
        return cb(null)
      }

      self._getInputNode(node.id, node.seq - 1, opts).then(next => {
        heads[headIndex] = next
        return cb(null)
      }, err => cb(err))
    }
  }

  async _createInputBatch (input, batch, clock) {
    const nodes = []

    // Only the first block in the batch stores the keys, and only the last stores the clock
    const compressed = await this._compressClock(input, input.length, clock)

    for (let i = 0; i < batch.length; i++) {
      const batchOffset = (batch.length !== 1) ? [i, batch.length - 1 - i] : null
      const node = {
        value: !b.isBuffer(batch[i]) ? b.from(batch[i]) : batch[i],
        key: input.key,
        batch: batchOffset,
        clock: null,
        keys: null
      }
      if (i === 0) {
        node.keys = compressed.keys
      }
      if (i === batch.length - 1) {
        node.clock = compressed.clock
      }
      nodes.push(node)
    }

    if (input.length === 0) {
      nodes[0].header = {
        protocol: INPUT_PROTOCOL
      }
    }

    return nodes.map(node => c.encode(NodeSchema, node))
  }

  async _append (value, clock) {
    if (!this.opened) await this.ready()
    if (!this.localInput) throw new Error('Must be an Autobase input to append')
    if (!Array.isArray(value)) value = [value]
    clock = clockToMap(clock || await this.latest())

    // Make sure that causal information propagates.
    // This is tracking inputs that were present in the previous append, but have since been removed.
    const head = await this._getInputNode(this.localInput, this.localInput.length - 1)
    const inputId = b.toString(this.localInput.key, 'hex')

    if (head && head.clock) {
      for (const [id, seq] of head.clock) {
        if (id === inputId || clock.has(id)) continue
        clock.set(id, seq)
      }
    }

    const batch = await this._createInputBatch(this.localInput, value, clock)
    return this.localInput.append(batch)
  }

  async append (value, clock, input) {
    if (!this.opened) await this._opening
    const release = await this._lock()
    try {
      return await this._append(value, clock, input)
    } finally {
      release()
    }
  }

  async update (opts = {}) {
    if (!this.opened) await this._opening
    if (!this._internalView) throw new Error('Must create a view before updating it')
    if (opts.local) return this._internalView.ready()
    return this._internalView.update()
  }

  async _close () {
    for (const input of this.inputs) {
      input.removeListener('append', this._onappend)
    }
    const inputsClosing = [...this._inputsByKey.values()].map(i => i.close())
    const outputsClosing = [...this._outputsByKey.values()].map(os => os.map(o => o.close()))
    await Promise.all([
      ...inputsClosing,
      ...outputsClosing.flat()
    ])
  }

  static async isAutobase (core) {
    if (core.length === 0) return false
    try {
      const block = await core.get(0, { valueEncoding: 'binary' })
      const header = decodeHeader(block)
      const protocol = header && header.protocol
      return !!protocol && (protocol === INPUT_PROTOCOL || protocol === OUTPUT_PROTOCOL)
    } catch {
      return false
    }
  }
}
Autobase.INPUT = 'input'
Autobase.OUTPUTS = 'outputs'

module.exports = Autobase

function isFork (head, heads) {
  if (!head) return false
  for (const other of heads) {
    if (!other) continue
    if (head.lte(other)) return false
  }
  return true
}

function forkSize (node, i, heads) {
  const high = {}

  for (const head of heads) {
    if (head === node) continue
    for (const [key, seq] of head.clock) {
      const length = seq + 1
      if (length > (high[key] || 0)) high[key] = length
    }
  }

  let s = 0

  for (const [key, seq] of node.clock) {
    const length = seq + 1
    const h = high[key] || 0
    if (length > h) s += length - h
  }

  return s
}

function forkInfo (heads) {
  const forks = []
  const clock = new Map()

  for (const head of heads) {
    if (!head) continue
    if (isFork(head, heads)) forks.push(head)
    clock.set(head.id, head.seq)
  }

  const sizes = forks.map(forkSize)
  let smallest = 0
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] === sizes[smallest] && forks[i].key < forks[smallest].key) {
      smallest = i
    } else if (sizes[i] < sizes[smallest]) {
      smallest = i
    }
  }

  return {
    forks,
    clock,
    smallest
  }
}

function clockToMap (clock) {
  if (!clock) return new Map()
  if (clock instanceof Map) return clock
  if (Array.isArray(clock)) return new Map(clock)
  return new Map(Object.entries(clock))
}
