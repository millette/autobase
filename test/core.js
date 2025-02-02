const test = require('brittle')
const ram = require('random-access-memory')
const Hypercore = require('hypercore')

const {
  create,
  apply,
  addWriter,
  addWriterAndSync,
  confirm,
  replicateAndSync
} = require('./helpers')

test('core -  no new session if closed (hypercore compat)', async t => {
  const [base] = await create(1, apply, store => store.get('test'))
  const normalCore = new Hypercore(ram)
  const linearizedSessionCore = base.view
  const snapshotSession = linearizedSessionCore.snapshot()

  await Promise.all([
    linearizedSessionCore.close(),
    normalCore.close(),
    snapshotSession.close()
  ])

  // LinearisedCore.session handles snapshots differently than hypercore.session,
  // so just testing that explicitly too

  t.exception(() => normalCore.session(), /SESSION_CLOSED/)
  t.exception(() => normalCore.snapshot(), /SESSION_CLOSED/)

  t.exception(() => linearizedSessionCore.session(), /SESSION_CLOSED/)
  t.exception(() => linearizedSessionCore.snapshot(), /SESSION_CLOSED/)

  t.exception(() => snapshotSession.session(), /SESSION_CLOSED/)
  t.exception(() => snapshotSession.snapshot(), /SESSION_CLOSED/)
})

test('core - seek', async t => {
  const [base] = await create(1, apply, store => store.get('test'))

  const b1 = base.view.byteLength
  await base.append('hello')

  const b2 = base.view.byteLength
  await base.append('and')

  const b3 = base.view.byteLength
  await base.append('goodbye')

  t.alike(await base.view.seek(b1), [0, 0])
  t.alike(await base.view.seek(b2), [1, 0])
  t.alike(await base.view.seek(b3), [2, 0])

  t.alike(await base.view.seek(b1 + 1), [0, 1])
  t.alike(await base.view.seek(b2 + 1), [1, 1])
  t.alike(await base.view.seek(b3 + 1), [2, 1])

  t.alike(await base.view.seek(b3 + 10), null)

  // expected behaviour?
  // t.alike(await base.view.seek(b1 - 10), null)
})

test('core - seek multi writer', async t => {
  const [a, b] = await create(2, scopedApply, store => store.get('test'))

  await addWriter(a, b)
  await confirm([a, b])

  await a.append('hello')
  await replicateAndSync([a, b])

  await b.append('and')
  await replicateAndSync([a, b])

  await a.append('goodbye')
  await replicateAndSync([a, b])

  t.is(a.view.length, 3)
  t.is(a.view.byteLength, 15)
  t.is(a.view.indexedLength, 1)
  t.is(a.view.indexedByteLength, 5)

  t.alike(a.view.length, b.view.length)
  t.alike(a.view.byteLength, b.view.byteLength)
  t.alike(a.view.indexedLength, b.view.indexedLength)
  t.alike(a.view.indexedByteLength, b.view.indexedByteLength)

  let i = 0
  while (i++ < a.view.byteLength) {
    t.alike(a.view.seek(i), b.view.seek(i))
  }

  // synced so views should be same
  while (i++ < a.view.byteLength) {
    t.alike(a.view.seek(i), b.view.seek(i))
  }

  // byteLength tests are apply dependent
  async function scopedApply (batch, view, base) {
    for (const { value } of batch) {
      if (value === null) continue
      if (value.add) {
        await base.addWriter(Buffer.from(value.add, 'hex'))
        continue
      }

      if (view) await view.append(value)
    }
  }
})

test('core - userData', async t => {
  const [base] = await create(1, apply, store => store.get('test'))

  await base.view.setUserData('first', Buffer.from('hello'))
  await base.view.setUserData('second', Buffer.from('goodbye'))

  t.alike(await base.view.getUserData('first'), Buffer.from('hello'))
  t.alike(await base.view.getUserData('second'), Buffer.from('goodbye'))
  t.alike(await base.view.getUserData('third'), null)

  const session = base.view.session()
  t.alike(await session.getUserData('first'), Buffer.from('hello'))

  await session.setUserData('first', Buffer.from('change'))

  t.alike(await base.view.getUserData('first'), Buffer.from('change'))
  t.alike(await session.getUserData('first'), Buffer.from('change'))
})

test('core - properties', async t => {
  const [base] = await create(1, apply, store => store.get('test'))

  await base.append('hello, world!')

  t.ok(base.view._source.core.id)
  t.is(base.view.id, base.view._source.core.id)
  t.is(base.view.key, base.view._source.core.key)
  t.is(base.view.discoveryKey, base.view._source.core.discoveryKey)
})

test('core - indexed view', async t => {
  const [a, b] = await create(2, apply, store => store.get('test'))

  const normal = a.view.session({ snapshot: false })
  const indexed = a.view.session({ snapshot: false, indexed: true })

  await normal.ready()
  await indexed.ready()

  t.absent(normal.indexed)
  t.ok(indexed.indexed)

  let normals = 0
  let indexeds = 0

  normal.on('append', () => { normals++ })
  indexed.on('append', () => { indexeds++ })

  a.view._source.debug = true
  await a.append('hello, world!')

  await new Promise(resolve => setImmediate(resolve))

  t.is(normals, 1)
  t.is(indexeds, 1)

  await addWriterAndSync(a, b)

  await a.append('bicycle!')

  t.is(a.linearizer.indexers.length, 2)

  await new Promise(resolve => setImmediate(resolve))

  t.is(normals, 2)
  t.is(indexeds, 1)

  t.is(normal.length, 2)
  t.is(indexed.length, 1)

  await confirm([a, b])

  // get sigs back and forth
  await b.append(null)
  await replicateAndSync([a, b])
  await a.append(null)
  await replicateAndSync([a, b])

  t.is(indexed.length, 2)
  t.is(indexeds, 2)
})
