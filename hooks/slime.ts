// 젤리 슬라임: 그림 자료 · 장 만들기 · 칸 글(터미널) · SVG(데스크톱) · 상태 고르기. 엔진 호출 없는 순수 함수들.
// 그림 자료는 설계서(2026-11-19-live-trace-slime-design.md) 4절 그대로.
import type { Phase, Sub, TurnStatus } from '../types'

import { agentName } from './describe'

export type SlimeState = 'think' | 'search' | 'read' | 'fix' | 'verify' | 'wait' | 'block' | 'fail' | 'done' | 'rest'
type Grid = (string | null)[][]
type Body = 'normal' | 'wait' | 'block' | 'fail' | 'rest'
type Eyes = 'open' | 'closed' | 'happy' | 'x'
type Prop = { at: number; col: number; rows: string[]; pal: Record<string, string> }

// 몸 색 [몸, 반짝임, 눈 · 입]
const BODY: Record<Body, [string, string, string]> = {
  normal: ['#69db7c', '#d3f9d8', '#123018'],
  wait: ['#74c0fc', '#e7f5ff', '#0b2b44'],
  block: ['#ff8787', '#ffe3e3', '#4a0d0d'],
  fail: ['#adb5bd', '#f1f3f5', '#343a40'],
  rest: ['#51a35f', '#b2dfbb', '#123018'],
}
const SHADOW = '#2b3a2e'
// 16×16 의 왼쪽 12칸이 몸. g 몸 · h 반짝임 · L/R 눈(2×2) · m 입 · d 그림자
const SLIME = ['............', '............', '............', '....gggg....', '..gggggggg..', '.gghgggggggg', '.ghgggggggg.', 'ggLLggggRRgg', 'ggLLggggRRgg', 'gggggmmggggg', 'gggggggggggg', 'gggggggggggg', '.gggggggggg.', '..dddddddd..', '............', '............']
// 통통 튈 때 아래 장: 한 줄 낮고 옆으로 넓음
const SQUASH = ['............', '............', '............', '............', '...gggggg...', '.gggggggggg.', 'gghggggggggg', 'ggLLggggRRgg', 'ggLLggggRRgg', 'gggggmmggggg', 'gggggggggggg', 'gggggggggggg', 'gggggggggggg', '.dddddddddd.', '............', '............']
const EYES: Record<Eyes, [string, string]> = { open: ['EE', 'EE'], closed: ['..', 'EE'], happy: ['EE', '..'], x: ['E.', '.E'] }
// 8×8 도우미 꼬마(줄이지 않고 따로 그림). 오른쪽 위 (0,7) 한 점 = 상태 색
const MINI = ['........', '..gggg..', '.gghggg.', 'gEggggEg', 'gggmmggg', 'gggggggg', '.gggggg.', '..dddd..']
const MINI_SQ = ['........', '........', '.ggggggg', 'gghggggg', 'gEggggEg', 'gggmmggg', 'gggggggg', '.dddddd.']

const P = (at: number, rows: string[], pal: Record<string, string> = {}, col = 11): Prop => ({ at, col, rows, pal })
const Z = (at: number, col: number): Prop => P(at, ['AAA', '.A.', 'AAA'], {}, col)
const W = { W: '#f8f9fa' }
const WOOD = { h: '#8d6e63' }

type Spec = {
  label: string
  accent: string
  ms: number
  body: Body
  eyes: Eyes
  bounce?: true
  squash?: true
  /** 장마다 얹는 물건(한 장에 여럿 가능) */
  props: Prop[][]
}
const SPEC: Record<SlimeState, Spec> = {
  think: { label: '생각 중', accent: '#6ea8fe', ms: 400, body: 'normal', eyes: 'happy', bounce: true,
    props: [[P(0, ['.WWWW', 'WA.WW', '.WWWW', '..W..'], W)], [P(0, ['.WWWW', 'WAWAW', '.WWWW', '..W..'], W)], [P(0, ['.WWWW', 'WAWAA', '.WWWW', '..W..'], W)]] },
  search: { label: '찾는 중', accent: '#ffd43b', ms: 400, body: 'normal', eyes: 'open', bounce: true,
    props: [[P(8, ['.AAA.', 'A...A', 'A.G.A', '.AAA.', '...hh', '....h'], { G: '#e7f5ff', ...WOOD })], [P(7, ['.AAA.', 'A...A', 'A.G.A', '.AAA.', '...hh', '....h'], { G: '#e7f5ff', ...WOOD })]] },
  read: { label: '읽는 중', accent: '#b197fc', ms: 500, body: 'normal', eyes: 'open',
    props: [[P(9, ['AAAAA', 'APPPA', 'APPPA', 'AAAAA'], { P: '#f8f9fa' })], [P(9, ['AAAAA', 'APAPA', 'APAPA', 'AAAAA'], { P: '#f8f9fa' })]] },
  fix: { label: '고치는 중', accent: '#ff922b', ms: 300, body: 'normal', eyes: 'open', bounce: true,
    props: [[P(6, ['HHHA.', 'HHHA.', '.hh..', '.hh..', '.hh..'], { H: '#adb5bd', ...WOOD })], [P(8, ['HHHA.', 'HHHA.', '.hh..', '.hh..', '.hh..'], { H: '#adb5bd', ...WOOD })]] },
  verify: { label: '검사 중', accent: '#20c997', ms: 400, body: 'normal', eyes: 'open', bounce: true,
    props: [[P(7, ['.....', '.....', 'A....', '.A...'])], [P(7, ['.....', '.....', 'A.A..', '.A...'])], [P(7, ['....A', '...A.', 'A.A..', '.A...'])]] },
  wait: { label: '답을 기다려요', accent: '#4dabf7', ms: 600, body: 'wait', eyes: 'open',
    props: [[P(0, ['WWWWW', 'WWAAW', 'WWWAW', 'WWAWW', '.WWW.', '..A..'], W)], [P(1, ['WWWWW', 'WWAAW', 'WWWAW', 'WWAWW', '.WWW.', '..A..'], W)]] },
  block: { label: '막힘', accent: '#fa5252', ms: 400, body: 'block', eyes: 'open', squash: true,
    props: [[P(0, ['..A..', '..A..', '..A..', '.....', '..A..', '...S.', '.....'], { S: '#74c0fc' })], [P(0, ['.....', '.....', '.....', '.....', '.....', '.....', '...S.'], { S: '#74c0fc' })]] },
  fail: { label: '실패', accent: '#868e96', ms: 500, body: 'fail', eyes: 'x', squash: true,
    props: [[P(1, ['A...A', '.A.A.', '..A..', '.A.A.', 'A...A'])], [P(1, ['..A..', '..A..', 'AAAAA', '..A..', '..A..'])]] },
  done: { label: '끝남 ✓', accent: '#51cf66', ms: 600, body: 'normal', eyes: 'happy', bounce: true,
    props: [[P(0, ['..A..', '.AAA.', '..A..', '....A', '.....'])], [P(0, ['.....', '..A..', '.....', '...A.', '..AAA'])]] },
  rest: { label: '쉬는 중', accent: '#a5d8ff', ms: 700, body: 'rest', eyes: 'closed', bounce: true,
    props: [[Z(6, 12)], [Z(6, 12), Z(3, 13)], [Z(6, 12), Z(3, 13), Z(0, 11)], [Z(3, 13), Z(0, 11)]] },
}

/** 상태마다 이름표 글 · 상태 색 · 장 간격 · 장 수 */
export const SLIME_SPEC: Record<SlimeState, { label: string; accent: string; ms: number; frames: number }> = Object.fromEntries(
  (Object.keys(SPEC) as SlimeState[]).map(k => {
    const s = SPEC[k]
    // 몸이 통통 튀면 2장 주기와 물건 주기를 맞춰 한 바퀴
    const frames = s.bounce ? Math.max(2, s.props.length % 2 === 0 ? s.props.length : s.props.length * 2) : s.props.length
    return [k, { label: s.label, accent: s.accent, ms: s.ms, frames }]
  }),
) as Record<SlimeState, { label: string; accent: string; ms: number; frames: number }>

const paint = (grid: Grid, s: Spec, frame: number) => {
  for (const q of s.props[frame % s.props.length] ?? []) {
    q.rows.forEach((row, dy) =>
      [...row].forEach((ch, dx) => {
        const y = q.at + dy
        const x = q.col + dx
        if (ch === '.' || y >= grid.length || x >= (grid[0]?.length ?? 0)) return
        const r = grid[y]
        if (r) r[x] = ch === 'A' ? s.accent : (q.pal[ch] ?? null)
      }),
    )
  }
}

/** 16×16 색 격자(`#rrggbb` 또는 빈 칸 null) */
export const slimeFrame = (state: SlimeState, frame: number): Grid => {
  const s = SPEC[state]
  const [g, hi, e] = BODY[s.body]
  const rows = s.squash || (s.bounce && frame % 2 === 1) ? SQUASH : SLIME
  const grid: Grid = rows.map(row => {
    const out: (string | null)[] = Array(16).fill(null)
    ;[...row].forEach((ch, x) => {
      if (ch === '.') return
      if (ch === 'L' || ch === 'R') {
        // 눈 2×2: 줄은 7 · 8, 칸은 그 글자의 첫 자리 · 둘째 자리
        return
      }
      out[x] = ch === 'h' ? hi : ch === 'm' ? e : ch === 'd' ? SHADOW : g
    })
    return out
  })
  rows.forEach((row, y) => {
    for (const ch of ['L', 'R'] as const) {
      const first = row.indexOf(ch)
      if (first < 0) continue
      const pat = EYES[s.eyes][y - 7] ?? '..'
      ;[0, 1].forEach(i => {
        const r = grid[y]
        if (r) r[first + i] = pat[i] === 'E' ? e : g
      })
    }
  })
  paint(grid, s, frame)
  return grid
}

/** 8×8 도우미 꼬마 */
export const miniFrame = (state: SlimeState, frame: number): Grid => {
  const s = SPEC[state]
  const [g, hi, e] = BODY[s.body]
  const rows = s.bounce && frame % 2 === 1 ? MINI_SQ : MINI
  const grid: Grid = rows.map(row =>
    [...row].map(ch => (ch === '.' ? null : ch === 'h' ? hi : ch === 'E' || ch === 'm' ? e : ch === 'd' ? SHADOW : g)),
  )
  const top = grid[0]
  if (top) top[7] = s.accent
  return grid
}

const DEFAULT = 0x01000000
const rgb = (c: string | null | undefined): number => (c ? parseInt(c.slice(1), 16) : DEFAULT)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// ponytail: 엔진 런타임의 toBase64 유무에 기대지 않으려고 몇 줄짜리 인코더
const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${b === undefined ? '=' : B64[(n >> 6) & 63]}${c === undefined ? '=' : B64[n & 63]}`
  }
  return out
}

/** 위아래 두 픽셀을 한 칸으로(위가 있으면 ▀ 글자색 = 위 · 배경 = 아래, 아래만 있으면 ▄) → Raster 의 cells */
export const toCells = (grid: Grid): string => {
  const words: number[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? []
    const bottom = grid[y + 1] ?? []
    for (let x = 0; x < top.length; x++) {
      const t = top[x]
      const b = bottom[x]
      if (t) words.push(0x2580, rgb(t), rgb(b))
      else if (b) words.push(0x2584, rgb(b), DEFAULT)
      else words.push(0x20, DEFAULT, DEFAULT)
    }
  }
  return toBase64(new Uint8Array(Uint32Array.from(words).buffer))
}

const BY_PHASE: Record<Phase, SlimeState> = { explore: 'search', guide: 'read', change: 'fix', verify: 'verify' }
const REST_AFTER_MS = 5 * 60_000
const BLOCK_SHOW_MS = 10_000
const MINI_DONE_MS = 30_000

/** 슬라임 상태(설계서 5절): 가장 최근 작업 · 지금 도는 도구 · 훅이 막은 때 */
export const pickState = (x: {
  task?: { status: TurnStatus; asked?: true; endedAt?: number }
  running?: { tool: string; phase: Phase }
  blockedAt?: number
  now: number
}): SlimeState => {
  const t = x.task
  if (t === undefined || t.status === 'idle') return 'rest'
  if (t.status === 'running') {
    if (x.running?.tool === 'AskUserQuestion') return 'wait'
    if (x.blockedAt !== undefined && x.now - x.blockedAt < BLOCK_SHOW_MS) return 'block'
    return x.running ? BY_PHASE[x.running.phase] : 'think'
  }
  if (t.status === 'answer') {
    if (t.asked === true) return 'wait'
    return t.endedAt !== undefined && x.now - t.endedAt >= REST_AFTER_MS ? 'rest' : 'done'
  }
  return t.status === 'aborted' ? 'block' : 'fail'
}

/** 도우미 꼬마 상태: 마지막 동작 단계(없으면 생각 중), 끝난 뒤 30초만 끝남, 그 뒤 · 거절은 안 그림 */
export const pickMini = (x: { status: Sub['status']; startedAt: number; ms?: number; phase?: Phase; now: number }): SlimeState | undefined => {
  if (x.status === 'running') return x.phase ? BY_PHASE[x.phase] : 'think'
  if (x.status === 'done' && x.now - (x.startedAt + (x.ms ?? 0)) <= MINI_DONE_MS) return 'done'
  return undefined
}

/** 「탐색 · 찾는 중」: 도우미 종류를 짧게(「… 도우미」 를 떼고) + 상태 */
export const miniLabel = (type: string, state: SlimeState): string => {
  const name = agentName(type).replace(/\s*도우미$/, '') || '도우미'
  return `${name} · ${SLIME_SPEC[state].label}`
}

/** 데스크톱 · VS Code 용 SVG 한 장 */
export const toSvg = (grid: Grid, px: number): string => {
  const w = grid[0]?.length ?? 0
  let rects = ''
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`
    }),
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * px}" height="${grid.length * px}" viewBox="0 0 ${w} ${grid.length}" shape-rendering="crispEdges">${rects}</svg>`
}
