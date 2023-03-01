import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connectVertical } from '@acala-network/chopsticks'

import { balance, expectEvent, expectExtrinsicSuccess, expectJson, sendTransaction, testingPairs} from '../helper'
import networks from '../networks'

describe('Karura <-> Kusama', async () => {
  const kusama = await networks.kusama({ wasmOverride: './wasm/kusama_runtime-v9380.compact.compressed.wasm' })
  const karura = await networks.karura({ wasmOverride: './wasm/karura-2140.wasm' })
  await connectVertical(kusama.chain, karura.chain)

  const { alice } = testingPairs()

  afterAll(async () => {
    await kusama.teardown()
    await karura.teardown()
  })

  beforeEach(async () => {
    await karura.dev.setStorage({
      System: {
        Account: [[[alice.address], { data: { free: 10 * 1e12 } }]]
      },
      Tokens: {
        Accounts: [
          [[alice.address, { Token: 'KSM' }], { free: 10 * 1e12 }],
          [[alice.address, { Token: 'LKSM' }], { free: 100 * 1e12 }]
        ]
      },
      Sudo: {
        Key: alice.address
      }
    })
    await kusama.dev.setStorage({
      System: {
        Account: [[[alice.address], { data: { free: 10 * 1e12 } }]]
      }
    })
  })

  it('Karura transfer assets to kusama', async () => {
    const tx = await sendTransaction(
      karura.api.tx.xTokens
        .transfer(
          {
            Token: 'KSM'
          },
          1e12,
          {
            V1: {
              parents: 1,
              interior: {
                X1: {
                  AccountId32: {
                    network: 'Any',
                    id: alice.addressRaw
                  }
                }
              }
            }
          },
          'Unlimited'
        )
        .signAsync(alice)
    )

    await karura.chain.newBlock()
    await kusama.chain.upcomingBlock()

    expectExtrinsicSuccess(await tx.events)
    expectEvent(await tx.events, {
      event: expect.objectContaining({
        section: 'xTokens',
        method: 'TransferredMultiAssets'
      })
    })

    expectJson(await karura.api.query.tokens.accounts(alice.address, { Token: 'KSM' })).toMatchInlineSnapshot(`
      {
        "free": 9000000000000,
        "frozen": 0,
        "reserved": 0,
      }
    `)

    expect(await balance(kusama.api, alice.address)).toMatchInlineSnapshot(`
      {
        "feeFrozen": 0,
        "free": 10999909712564,
        "miscFrozen": 0,
        "reserved": 0,
      }
    `)

    expectEvent(await kusama.api.query.system.events(), {
      event: expect.objectContaining({
        method: 'ExecutedUpward',
        section: 'ump',
        data: [
          '0x740fe61d99a98beab81994c32b7f31445044b01b2fd682936fc5e12ec2c229cb',
          {
            Complete: expect.anything()
          }
        ]
      })
    })
  })


  it('Kusama transfer assets to Karura', async () => {
    const tx = await sendTransaction(
      kusama.api.tx.xcmPallet.limitedReserveTransferAssets(
        {
          V3: {
            parents: 0,
            interior: {
              X1: { Parachain: 2000 }
            }
          }
        },
        {
          V3: {
            parents: 0,
            interior: {
              X1: {
                AccountId32: {
                  id: alice.addressRaw
                }
              }
            }
          }
        },
        {
          V3: [
            {
              id: { Concrete: { parents: 0, interior: 'Here'}},
              fun: {Fungible : "1000000000000"}
            }
          ]
        },
        0,
        'Unlimited'
      ).signAsync(alice, { nonce: 0 })
    )

    await kusama.chain.newBlock()
    //
    expectExtrinsicSuccess(await tx.events)
    expectEvent(await tx.events, {
      event: expect.objectContaining({
        section: 'xcmPallet',
        method: 'Attempted'
      })
    })

    expectEvent(await tx.events, {
      event: expect.objectContaining({
        method: 'Transfer',
        section: 'balances',
      })
    })

    expect(await balance(kusama.api, alice.address)).toMatchInlineSnapshot(`
      {
        "feeFrozen": 0,
        "free": 8999379005607,
        "miscFrozen": 0,
        "reserved": 0,
      }
    `)

    await karura.chain.newBlock()
    expectJson(await karura.api.query.tokens.accounts(alice.address, { Token: 'KSM' })).toMatchInlineSnapshot(`
      {
        "free": 10999955836390,
        "frozen": 0,
        "reserved": 0,
      }
    `)

  })

  it('Homa stake works', async () => {
    const tx1 = await sendTransaction(karura.api.tx.homa.mint(1e12).signAsync(alice, { nonce: 0 }))
    const tx2 = await sendTransaction(
      karura.api.tx.sudo.sudo(karura.api.tx.homa.forceBumpCurrentEra(0)).signAsync(alice, { nonce: 1 })
    )

    await karura.chain.newBlock()
    await kusama.chain.upcomingBlock()

    expectExtrinsicSuccess(await tx1.events)
    expectExtrinsicSuccess(await tx2.events)

    expectEvent(await tx2.events, {
      event: expect.objectContaining({
        method: 'CurrentEraBumped',
        section: 'homa',
      }),
    })

    // console.dir((await kusama.api.query.system.events()).toHuman(), { depth: null })

    expectEvent(await kusama.api.query.system.events(), {
      event: expect.objectContaining({
        method: 'ExecutedUpward',
        section: 'ump',
        data: [
          '0x7a2dc201d461fb785c8d38af7a6f0ac35ae319e26699890ad1647b5ee4e086d2', // transfer
          {
            Complete: expect.anything()
          }
        ]
      })
    })

    expectEvent(await kusama.api.query.system.events(), {
      event: expect.objectContaining({
        method: 'ExecutedUpward',
        section: 'ump',
        data: [
          '0xd38682b5a8a7149ef9ab3469690e6b806926174327f7e4946e8990095a0997be', // transact bond_extra
          {
            Complete: expect.anything()
          }
        ]
      })
    })

    expectEvent(await kusama.api.query.system.events(), {
      event: expect.objectContaining({
        method: 'Bonded',
        section: 'staking'
      })
    })
  })

  it('Homa redeem unbond works', async () => {
    const tx3 = await sendTransaction(karura.api.tx.homa.requestRedeem(10 * 1e12, false).signAsync(alice, { nonce: 0 }))
    const tx4 = await sendTransaction(
      karura.api.tx.sudo.sudo(karura.api.tx.homa.forceBumpCurrentEra(0)).signAsync(alice, { nonce: 1 })
    )

    await karura.chain.newBlock()

    // console.dir((await tx3.events).map(x => x.toHuman()), { depth: null })
    // console.dir((await tx4.events).map(x => x.toHuman()), { depth: null })

    expectExtrinsicSuccess(await tx3.events)
    expectEvent(await tx3.events, {
      event: expect.objectContaining({
        method: 'RequestedRedeem',
        section: 'homa'
      })
    })

    expectExtrinsicSuccess(await tx4.events)
    expectEvent(await tx4.events, {
      event: expect.objectContaining({
        method: 'CurrentEraBumped',
        section: 'homa'
      })
    })

    await kusama.chain.upcomingBlock()

    const kusamaEvents = await kusama.api.query.system.events()
    // console.dir(kusamaEvents, { depth: null })

    expectEvent(kusamaEvents, {
      event: expect.objectContaining({
        method: 'ExecutedUpward',
        section: 'ump',
        data: [
          '0x10e5f14af53729290493c04e0c18403ceaf7fed7b0ccaa808d81d061587b9cca', // transact unbond
          {
            Complete: expect.anything()
          }
        ]
      })
    })

    expectEvent(kusamaEvents, {
      event: expect.objectContaining({
        method: 'Unbonded',
        section: 'staking'
      })
    })
  })
})