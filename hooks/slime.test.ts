import { describe, expect, test } from 'claude-code/testing'

import { SLIME_SPEC, miniFrame, miniLabel, pickMini, pickState, slimeFrame, toCells, toSvg } from './slime'
import type { SlimeState } from './slime'

const decode = (b64: string): Uint32Array => {
  const bin = atob(b64)
  return new Uint32Array(Uint8Array.from(bin, c => c.charCodeAt(0)).buffer)
}
const STATES = Object.keys(SLIME_SPEC) as SlimeState[]

describe('젤리 슬라임 그림', () => {
  test('상태 10가지', async () => {
    expect(STATES).toEqual(['think', 'search', 'read', 'fix', 'verify', 'wait', 'block', 'fail', 'done', 'rest'])
  })

  test('슬라임은 16칸 × 8줄, 글자는 ▀ · ▄ · 빈칸뿐', async () => {
    for (const s of STATES) {
      for (let f = 0; f < 4; f++) {
        const u = decode(toCells(slimeFrame(s, f)))
        expect(u.length).toBe(16 * 8 * 3)
        for (let i = 0; i < u.length; i += 3) expect([0x2580, 0x2584, 0x20].includes(u[i] ?? 0)).toBe(true)
      }
    }
  })

  test('상태마다 장 0 과 장 1 이 달라 움직임이 보인다', async () => {
    for (const s of STATES) expect(toCells(slimeFrame(s, 1))).not.toBe(toCells(slimeFrame(s, 0)))
  })

  test('몸 색이 상태를 말한다: 답 기다림 하늘색 · 막힘 빨강 · 실패 회색', async () => {
    // 몸 한가운데(눈 · 입 피한 자리) 픽셀
    expect(slimeFrame('wait', 0)[11]?.[5]).toBe('#74c0fc')
    expect(slimeFrame('block', 0)[11]?.[5]).toBe('#ff8787')
    expect(slimeFrame('fail', 0)[11]?.[5]).toBe('#adb5bd')
    expect(slimeFrame('search', 0)[11]?.[5]).toBe('#69db7c')
  })

  test('쉬는 중은 z 가 하나 → 둘 → 셋으로 늘어난다', async () => {
    const accent = SLIME_SPEC.rest.accent
    const count = (f: number) => slimeFrame('rest', f).flat().filter(c => c === accent).length
    expect(count(0) < count(1) && count(1) < count(2)).toBe(true)
  })

  test('도우미 꼬마는 8칸 × 4줄, 오른쪽 위 점은 상태 색', async () => {
    for (const s of STATES) {
      expect(miniFrame(s, 0)[0]?.[7]).toBe(SLIME_SPEC[s].accent)
      expect(decode(toCells(miniFrame(s, 0))).length).toBe(8 * 4 * 3)
    }
  })

  test('상태 고르기: 설계서 5절 표 그대로', async () => {
    const now = 1_000_000
    const run = (running?: { tool: string; phase: 'explore' | 'guide' | 'change' | 'verify' }, blockedAt?: number) =>
      pickState({ task: { status: 'running' }, now, ...(running ? { running } : {}), ...(blockedAt !== undefined ? { blockedAt } : {}) })
    expect(pickState({ now })).toBe('rest')
    expect(run({ tool: 'AskUserQuestion', phase: 'explore' })).toBe('wait')
    expect(run({ tool: 'Bash', phase: 'explore' }, now - 9_000)).toBe('block')
    expect(run({ tool: 'Bash', phase: 'explore' }, now - 11_000)).toBe('search')
    expect(run({ tool: 'Read', phase: 'guide' })).toBe('read')
    expect(run({ tool: 'Edit', phase: 'change' })).toBe('fix')
    expect(run({ tool: 'Bash', phase: 'verify' })).toBe('verify')
    expect(run()).toBe('think')
    expect(pickState({ task: { status: 'answer', asked: true, endedAt: now }, now })).toBe('wait')
    expect(pickState({ task: { status: 'answer', endedAt: now - 299_000 }, now })).toBe('done')
    expect(pickState({ task: { status: 'answer', endedAt: now - 300_000 }, now })).toBe('rest')
    expect(pickState({ task: { status: 'aborted' }, now })).toBe('block')
    expect(pickState({ task: { status: 'error' }, now })).toBe('fail')
    expect(pickState({ task: { status: 'refusal' }, now })).toBe('fail')
  })

  test('도우미 꼬마: 마지막 동작 단계, 동작이 없으면 생각 중, 끝나면 30초만 초록', async () => {
    const now = 100_000
    expect(pickMini({ status: 'running', startedAt: 0, phase: 'explore', now })).toBe('search')
    expect(pickMini({ status: 'running', startedAt: 0, now })).toBe('think')
    expect(pickMini({ status: 'done', startedAt: 50_000, ms: 21_000, now })).toBe('done')
    expect(pickMini({ status: 'done', startedAt: 50_000, ms: 19_000, now })).toBe(undefined)
    expect(pickMini({ status: 'denied', startedAt: 0, now })).toBe(undefined)
  })

  test('이름표: 도우미 종류 짧게 · 상태', async () => {
    expect(miniLabel('Explore', 'search')).toBe('탐색 · 찾는 중')
    expect(miniLabel('Plan', 'think')).toBe('설계 · 생각 중')
    expect(miniLabel('general-purpose', 'done')).toBe('도우미 · 끝남 ✓')
    expect(miniLabel('code-reviewer', 'fix')).toBe('code-reviewer · 고치는 중')
  })

  test('데스크톱용 SVG 는 칠한 픽셀마다 사각형 하나', async () => {
    const grid = miniFrame('done', 0)
    const filled = grid.flat().filter(Boolean).length
    expect(toSvg(grid, 4).match(/<rect /g)?.length).toBe(filled)
  })
})
