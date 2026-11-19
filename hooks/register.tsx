import { atom, read, update } from 'claude-code'
import type { Register, StateDollar } from 'claude-code'

import type { Call, CallStatus, Evidence, Group, HookAct, HookNote, Item, Phase, Story, Sub, Task, TurnStatus } from '../types'
import {
  agentName,
  base,
  citedCommits,
  clip,
  countActions,
  duration,
  evidenceOf,
  firstSentence,
  groupLabel,
  hookLabel,
  hookLine,
  hookNotes,
  itemText,
  labelOf,
  loadedText,
  linesOf,
  mergeEvidence,
  parseNarration,
  phaseOf,
  sourceOf,
  storyText,
  targetOf,
  upsertLog,
  ymd,
} from './describe'

const PANE = 'live-trace'
const TITLE = '작업 과정'
const NO_TITLE = '(설명 없이 시작)'
// shape 태그: 필드가 바뀌면 올린다(리로드 뒤 남은 예전 값을 버리게)
const calls = atom({ plugin: 'live-trace', key: 'calls' } as const, [], { shape: 'calls-4' })
const tasks = atom({ plugin: 'live-trace', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const focus = atom({ plugin: 'live-trace', key: 'focus' } as const, 0, { shape: 'focus-1' })
const subs = atom({ plugin: 'live-trace', key: 'subs' } as const, [], { shape: 'subs-2' })
const groups = atom({ plugin: 'live-trace', key: 'groups' } as const, [], { shape: 'groups-2' })
const evidence = atom({ plugin: 'live-trace', key: 'evidence' } as const, [], { shape: 'evidence-3' })
const bg = atom({ plugin: 'live-trace', key: 'bg' } as const, [], { shape: 'bg-2' })
const stories = atom({ plugin: 'live-trace', key: 'stories' } as const, [], { shape: 'stories-5' })
const opened = atom({ plugin: 'live-trace', key: 'opened' } as const, [], { shape: 'opened-1' })
const notes = atom({ plugin: 'live-trace', key: 'notes' } as const, [], { shape: 'notes-1' })

// 작업 폴더 이름(패널 제목 · 기록 머리). 다시 불러오면 session.start 가 다시 채운다
let where = ''
const titleOf = () => (where !== '' ? `${TITLE} (${where})` : TITLE)

const RULE = `[live-trace] 옆 패널이 사용자에게 작업 과정을 보여 준다. 패널은 네가 화면에 쓰는 문장을 그대로 읽는다.
- 도구를 부르기 전 문장은 「무엇을 · 왜」 한 줄 한국어로 쓴다. 예: 네모가 된 이유부터 찾으려고 버튼 변경 이력을 봅니다
- 여러 단계 작업이면 각 단계를 시작하는 문장 앞에 [지금 단계/전체 단계] 를 붙인다. 예: [2/4] 피그마 원본과 비교합니다
- 규칙 · 메모리 · 스킬의 지침을 따라 정할 때는 그 문장 끝에 (지침: 이름) 을 붙인다. 예: (지침: 디자인 우선순위)
- Bash · PowerShell 의 description 은 한국어로 쓴다.
- 사용자가 지난 작업을 「어떻게 했어?」 「무슨 근거로 했어?」 물으면 ~/.claude/live-trace/ 의 날짜별 기록(YYYY-MM-DD.md)을 읽고, 상황 → 쓴 스킬 → 따른 지침 → 근거 → 한 일 → 검증 순서로 답한다.`

const PHASES: readonly [Phase, string][] = [
  ['explore', '조사'],
  ['guide', '근거'],
  ['change', '변경'],
  ['verify', '검증'],
]
const PHASE_PCT: Record<Phase, number> = { explore: 15, guide: 35, change: 60, verify: 85 }
const ICON: Record<CallStatus, string> = { running: '⊷', ok: '✓', error: '✗', denied: '⊘' }
const COLOR = { running: 'warning', ok: 'success', error: 'error', denied: 'error' } as const
const ORDER: readonly Evidence['kind'][] = ['commit', 'external', 'guide', 'skill']
// 훅: 막음은 빨강, 묻기 · 고침은 노랑, 지시 덧붙임은 색 없이
const HOOK_COLOR: Record<HookAct, 'error' | 'warning' | undefined> = {
  block: 'error',
  ask: 'warning',
  edit: 'warning',
  note: undefined,
  load: undefined,
}
const HOOK_ORDER: readonly HookAct[] = ['block', 'ask', 'edit', 'note', 'load']
const DONE_LABEL: Record<TurnStatus, string> = {
  idle: '대기',
  running: '작업 중',
  answer: '끝남',
  aborted: '중단됨',
  refusal: '거절됨',
  error: '오류로 멈춤',
}

// 이어서 하는 턴: 입력 없이 시작했거나(빈 글) 시스템이 넣은 글(<task-notification> 등)
const isContinuation = (text: string) => text.trim() === '' || text.trimStart().startsWith('<')

const prettyModel = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${(m[1] ?? '').replace(/^./, c => c.toUpperCase())} ${m[2]}.${m[3]}` : id
}

/** 작업 하나의 진행률: [n/m] 단계가 있으면 그 단계의 가운데, 없으면 지나온 단계(조사 → 검증)로 어림 */
const progressOf = (t: Task, mine: readonly Call[], gs: readonly Group[]) => {
  const running = t.status === 'running'
  const step = [...gs].reverse().find(g => g.step)?.step
  const seen = new Set(mine.map(c => c.phase))
  const furthest = PHASES.map(([p]) => p).filter(p => seen.has(p)).at(-1)
  const pct = !running
    ? 100
    : step
      ? Math.round(((step.n - 0.5) / Math.max(1, step.m)) * 100)
      : furthest
        ? PHASE_PCT[furthest]
        : 5
  const text = !running ? '100%' : step ? `${step.n}/${step.m}단계 ${pct}%` : `약 ${pct}%`
  return { pct, text, step, seen }
}

/** 근거 + 그것을 찾은 단계에서 Claude 가 쓴 「무엇을 · 왜」 문장 */
const withWhy = (x: Pick<Evidence, 'kind' | 'text' | 'group'>, gs: readonly Group[]): Item => {
  const why = gs.find(g => g.n === x.group)?.title
  return why !== undefined && why !== NO_TITLE ? { kind: x.kind, text: x.text, why } : { kind: x.kind, text: x.text }
}

/** 끝난 작업 → 작업 설명 */
const buildStory = (
  t: Task,
  mine: readonly Call[],
  gs: readonly Group[],
  ev: readonly Evidence[],
  hs: readonly HookNote[],
  at: number,
  answer: string,
): Story => {
  const of = (k: Evidence['kind']) => ev.filter(x => x.kind === k).map(x => withWhy(x, gs))
  const commits = of('commit')
  // 문서(.md 등) 수정은 검증할 대상이 아니므로 「바꾼 뒤 검증 안 함」에서 뺀다
  const kinds = mine.map(c => (c.phase === 'change' && c.isDoc === true ? 'doc' : c.phase))
  const lastChange = kinds.lastIndexOf('change')
  const lastVerify = kinds.lastIndexOf('verify')
  const checks = [
    ...new Set(
      mine.filter(c => c.phase === 'verify').map(c => `${c.label} ${c.status === 'ok' ? '통과' : '실패'}`),
    ),
  ].slice(-5)
  const sources = countActions(mine.map(c => c.src))
  return {
    task: t.id,
    at,
    ...(where !== '' ? { where } : {}),
    request: t.request,
    ...(t.asks !== undefined && t.asks.length > 0 ? { asks: t.asks } : {}),
    status: t.status,
    skills: of('skill'),
    guides: of('guide'),
    // 막음 → 물음 → 고침 → 덧붙인 지시 → 불러온 규칙 순으로 6개까지
    hooks: [...hs].sort((a, b) => HOOK_ORDER.indexOf(a.act) - HOOK_ORDER.indexOf(b.act)).slice(0, 6),
    // 파일 이름은 나열하지 않는다(많으면 길어짐) — 종류별 개수만
    // 커밋은 최종 답이 든 것(없으면 마지막에 찾은 3개), 외부 근거는 3개까지
    basis: [
      ...citedCommits(
        commits.map(x => x.text),
        answer,
      ).flatMap(t => commits.filter(x => x.text === t).slice(0, 1)),
      ...of('external').slice(0, 3),
    ],
    sources,
    explored: sources.join(', '),
    ...(t.ms !== undefined ? { ms: t.ms } : {}),
    steps: gs.map(g => `${g.step ? `${groupLabel(g)} ` : ''}${g.title}`),
    checks,
    unverified: lastChange >= 0 && lastVerify < lastChange,
  }
}

/** 지금 작업 번호(가장 최근 요청) */
async function currentTask($: StateDollar): Promise<number> {
  return (await read($, tasks)).at(-1)?.id ?? 0
}

/** 요청 · 세션 시작 훅의 작업: 도는 작업이 있으면 그것, 없으면 -1(다음 작업이 가져감) */
async function hookTask($: StateDollar): Promise<number> {
  const last = (await read($, tasks)).at(-1)
  return last?.status === 'running' ? last.id : -1
}

/** 훅이 끼어든 일을 적는다(같은 일은 횟수만 올림) */
async function addNotes($: StateDollar, items: readonly Omit<HookNote, 'count'>[]): Promise<void> {
  if (items.length === 0) return
  await update($, notes, list => {
    const next = [...list]
    for (const it of items) {
      const i = next.findIndex(x => x.task === it.task && x.group === it.group && x.act === it.act && x.text === it.text)
      const old = next[i]
      if (old !== undefined) next[i] = { ...old, count: old.count + 1 }
      else next.push({ ...it, count: 1 })
    }
    return next.slice(-100)
  })
}

/** 도구 호출 하나에 훅이 한 일(막음 · 물음 · 고침 · 덧붙임) */
async function noteToolHook(
  $: StateDollar,
  id: string | undefined,
  r: { deny?: string; ask?: string; edited?: string; additionalContext?: readonly string[] },
): Promise<void> {
  const call = (await read($, calls)).find(c => c.id === id)
  if (call === undefined || call.agent !== undefined) return
  const where = { task: call.task, group: call.group }
  await addNotes($, [
    ...(r.deny !== undefined ? [{ ...where, act: 'block' as const, text: hookLine(r.deny) }] : []),
    ...(r.ask !== undefined ? [{ ...where, act: 'ask' as const, text: hookLine(r.ask) }] : []),
    ...(r.edited !== undefined ? [{ ...where, act: 'edit' as const, text: `${call.label} ${r.edited}` }] : []),
    ...hookNotes(r, where),
  ])
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    where = base(String(e.cwd ?? '')).replace(/^[/\\]+$/, '')
    await $.command.register({ name: 'trace', description: '작업 과정 패널 열기 · /trace 설명 = 마지막 작업 설명' })
    // 오른쪽 자리(전체 화면 모드)는 52칸, 입력창 위 자리는 14줄로 시작. 사람이 끌거나 키로 바꾼 크기가 우선.
    void $.ui.open({ id: PANE, title: titleOf(), columns: 52, rows: 14 })
    // 작업 중엔 1초마다 다시 그려 경과 시간이 흐르게(쉬는 동안은 그리지 않음)
    $.clock.every(1000, () => {
      void read($, tasks).then(ts => {
        if (ts.some(t => t.status === 'running')) $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  on('command.run', { command: 'trace' }, async ($, e) => {
    if (e.args.trim() === '설명') {
      const last = (await read($, stories)).at(-1)

      return { text: last ? storyText(last) : '아직 끝난 작업이 없습니다.' }
    }
    await $.ui.open({ id: PANE, title: titleOf(), columns: 52, rows: 14 })

    return { text: '작업 과정 패널을 열었습니다. 끝난 작업 설명은 /trace 설명' }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)

    return { sections: [...r.sections, { id: 'live-trace:narrate', text: RULE, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  // 사용자 요청 = 새 작업. 이어서 하는 턴(백그라운드 알림 · 같은 글로 다시 도는 반복)은 지금 작업에 붙인다.
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const last = (await read($, tasks)).at(-1)
      const text = clip(e.text, 200)
      const continued = last !== undefined && (isContinuation(e.text) || text === last.request) ? last : undefined
      // 작업이 시작되기 전에 훅이 한 일(요청 · 세션 시작)은 이 작업 것
      const id = continued?.id ?? (last?.id ?? 0) + 1
      await update($, notes, list => list.map(h => (h.task === -1 ? { ...h, task: id } : h)))
      if (continued !== undefined) {
        await update($, tasks, list =>
          list.map((t): Task => (t.id === continued.id ? { ...t, status: 'running', turnAt: now } : t)),
        )
      } else {
        const task: Task = {
          id,
          request: isContinuation(e.text) ? '' : text,
          status: 'running',
          startedAt: now,
          turnAt: now,
        }
        await update($, tasks, list => [...list, task].slice(-10))
        await update($, focus, () => 0) // 새 작업이 오면 그 작업을 본다
      }
    } else {
      await update($, subs, list => list.map((s): Sub => (s.id === e.agentId ? { ...s, status: 'running', ms: undefined } : s)))
    }

    return next(e)
  })

  // 작업 중에 사용자가 친 글: 엔진이 지금 턴에 넣어 주면 새 작업이 아니라 지금 작업의 「추가 요청」.
  // 기다리게 보낸 글(ctrl+x enter)은 제 턴을 따로 시작하므로 turn.start 에서 새 작업이 된다.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const mine = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (mine && e.turnId !== undefined && !e.wait && e.command === undefined && !('drop' in r)) {
      const last = (await read($, tasks)).at(-1)
      if (last !== undefined && last.status === 'running') {
        await update($, tasks, list =>
          list.map(t => (t.id === last.id ? { ...t, asks: [...(t.asks ?? []), clip(e.text, 200)].slice(-5) } : t)),
        )
      }
    }

    return r
  }).catch(($, e, next) => next(e)) // 관찰 전용

  // 화면에 쓰는 문장 → 그 뒤 도구들의 묶음 제목. 생각 조각은 읽지 않는다. 조각은 손대지 않고 넘긴다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      yield* next(e)
      return
    }
    let text = ''
    for await (const c of next(e)) {
      yield c
      if (c.kind === 'text') text += c.text
      if (c.kind !== 'tool') continue
      const said = parseNarration(text)
      text = ''
      try {
        const task = await currentTask($)
        let made: Group | undefined
        await update($, groups, list => {
          const last = [...list].reverse().find(g => g.task === task)
          if (said.title === '' && last !== undefined) {
            return list.map(g => (g === last ? { ...g, tools: [...g.tools, c.id] } : g))
          }
          made = {
            n: (list.at(-1)?.n ?? 0) + 1,
            task,
            title: said.title || NO_TITLE,
            tools: [c.id],
            ...(said.step ? { step: said.step } : {}),
          }
          return [...list, made].slice(-120)
        })
        const g = made
        if (g !== undefined && said.guides.length > 0) {
          await update($, evidence, list =>
            mergeEvidence(
              list,
              said.guides.map(t => ({ kind: 'guide', text: t, task, group: g.n, count: 1 })),
            ),
          )
        }
      } catch {
        // 관찰 전용: 기록이 실패해도 응답은 그대로
      }
    }
  })

  on('skill.prompt', async ($, e, next) => {
    const task = await currentTask($)
    const g = [...(await read($, groups))].reverse().find(x => x.task === task)?.n ?? 0
    await update($, evidence, list => mergeEvidence(list, [{ kind: 'skill', text: e.skill, task, group: g, count: 1 }]))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      await update($, subs, list =>
        list.map((s): Sub => (s.id === e.agentId ? { ...s, status: 'done', ms: now - s.startedAt } : s)),
      )

      return next(e)
    }
    const last = (await read($, tasks)).at(-1)
    if (last === undefined) return next(e)
    // 이어서 한 턴이면 걸린 시간을 더한다
    const t: Task = { ...last, status: e.reason, ms: (last.ms ?? 0) + e.durationMs }
    await update($, tasks, list => list.map(x => (x.id === t.id ? t : x)))
    const mine = (await read($, calls)).filter(c => c.task === t.id && c.agent === undefined)
    if (mine.length > 0) {
      const story = buildStory(
        t,
        mine,
        (await read($, groups)).filter(g => g.task === t.id),
        (await read($, evidence)).filter(x => x.task === t.id),
        (await read($, notes)).filter(h => h.task === t.id),
        now,
        e.answer,
      )
      await update($, stories, list => [...list.filter(s => s.task !== t.id), story].slice(-10))
      try {
        const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
        if (home !== undefined) {
          const path = `${home.replace(/\\/g, '/')}/.claude/live-trace/${ymd(now)}.md`
          let old = ''
          try {
            old = String(await $.fs.read(path))
          } catch {
            old = `# 작업 기록 ${ymd(now)}\n`
          }
          // 같은 작업은 한 절로: 이어서 한 턴이 끝나면 그 절을 새로 쓴다
          await $.fs.write(path, upsertLog(old, String(t.startedAt), storyText(story)))
        }
      } catch {
        // 기록 파일을 못 써도 패널은 그대로
      }
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const key = `${e.tool_use_id}:${startedAt}`
    const sub: Sub = {
      key,
      task: await currentTask($),
      type: e.subagentType,
      description: e.description,
      status: 'running',
      startedAt,
    }
    await update($, subs, list => [...list, sub].slice(-30))
    const spawned = await next(e)
    await update($, subs, list =>
      list.map((s): Sub =>
        s.key !== key ? s : spawned.deny !== undefined ? { ...s, status: 'denied' } : { ...s, id: spawned.agentId },
      ),
    )

    return spawned
  }).catch(($, e, next) => next(e)) // 관찰 전용

  // 턴이 멈출 때마다 엔진이 아는 백그라운드 목록으로 맞춘다(어느 작업에서 띄웠는지는 이어받는다)
  on('classic.Stop', async ($, e, next) => {
    const running = (e.background_tasks ?? []).filter(x => x.type !== 'subagent')
    const crons = e.session_crons ?? []
    const prev = await read($, bg)
    const cur = await currentTask($)
    const taskOf = (id: string, label: string) => prev.find(b => b.id === id || b.label === label)?.task ?? cur
    const item = (id: string, label: string) => ({ id, label, task: taskOf(id, label) })
    await update($, bg, () => [
      ...running.map(x =>
        item(
          x.id,
          x.type === 'shell'
            ? labelOf('Bash', { command: x.command ?? '', description: x.description })
            : clip(x.description || x.type),
        ),
      ),
      ...crons.map(c => item(c.id, c.recurring ? '정기 작업 예약됨' : '다시 진행 예약됨')),
    ])
    const r = await next(e)
    try {
      // 끝내려 할 때 훅이 막았으면(「테스트부터 돌려」 같은 되돌림) 지금 작업에 적는다
      await addNotes($, hookNotes(r, { task: cur, group: 0, at: '끝낼' }))
    } catch {
      // 관찰 전용
    }

    return r
  }).catch(($, e, next) => next(e))

  // 사용자 설정 훅은 이 mod 아래에서 돈다: next 의 결과가 곧 훅들이 한 일
  on('classic.PreToolUse', async ($, e, next) => {
    const r = await next(e)
    try {
      await noteToolHook($, e.tool_use_id, {
        ...(r.deny !== undefined ? { deny: r.deny } : {}),
        ...(r.ask !== undefined ? { ask: r.ask } : {}),
        ...(r.updatedInput !== undefined ? { edited: '입력값을 바꿔 실행' } : {}),
        ...(r.additionalContext !== undefined ? { additionalContext: r.additionalContext } : {}),
      })
    } catch {
      // 관찰 전용: 다시 부르지 않게 여기서 삼킨다
    }

    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    try {
      const changed = r.updatedToolOutput !== undefined || r.updatedMCPToolOutput !== undefined
      await noteToolHook($, e.tool_use_id, {
        ...(changed ? { edited: '결과를 바꿔 전달' } : {}),
        ...(r.additionalContext !== undefined ? { additionalContext: r.additionalContext } : {}),
      })
    } catch {
      // 관찰 전용
    }

    return r
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    try {
      await addNotes($, hookNotes(r, { task: await hookTask($), group: 0, at: '요청' }))
    } catch {
      // 관찰 전용
    }

    return r
  }).catch(($, e, next) => next(e))

  // 규칙 문서(CLAUDE.md · .claude/rules)가 대화에 올라올 때: 무엇을 · 왜 불러왔나
  on('classic.InstructionsLoaded', async ($, e, next) => {
    try {
      const task = await hookTask($)
      const group = task === -1 ? 0 : ([...(await read($, groups))].reverse().find(g => g.task === task)?.n ?? 0)
      await addNotes($, [{ task, group, act: 'load', text: loadedText(e.file_path, e.memory_type, e.load_reason) }])
    } catch {
      // 관찰 전용
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    try {
      await addNotes($, hookNotes(r, { task: await hookTask($), group: 0, at: '세션 시작' }))
    } catch {
      // 관찰 전용
    }

    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const args = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    // 도우미의 동작은 그 도우미를 띄운 작업에 붙는다
    const sub = e.agentId !== undefined ? (await read($, subs)).find(s => s.id === e.agentId) : undefined
    const task = sub?.task ?? (await currentTask($))
    const gs = await read($, groups)
    const group =
      e.agentId === undefined
        ? ((gs.find(g => g.tools.includes(e.tool_use_id)) ?? [...gs].reverse().find(g => g.task === task))?.n ?? 0)
        : 0
    const target = targetOf(tool, args)
    const call: Call = {
      id: e.tool_use_id,
      tool,
      label: labelOf(tool, args),
      src: sourceOf(tool, args),
      ...(target !== undefined ? { target } : {}),
      phase: phaseOf(tool, args),
      ...(/\.(md|txt)$/i.test(String(args.file_path ?? '')) ? { isDoc: true } : {}),
      task,
      group,
      status: 'running',
      startedAt,
      ...(e.agentId !== undefined ? { agent: e.agentId } : {}),
    }
    await update($, calls, list => [...list, call].slice(-500))
    const finish = async (status: CallStatus) => {
      const ms = (await $.clock.now()) - startedAt
      await update($, calls, list => list.map(c => (c.id === call.id ? { ...c, status, ms } : c)))
    }
    try {
      const ran = await next(e)
      await finish(ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok')
      if (e.agentId === undefined && ran.deny === undefined) {
        // 메모를 읽었으면 같은 폴더의 목차(MEMORY.md)에서 한글 제목을 찾는다
        let memoIndex = ''
        const path = String(args.file_path ?? '').replace(/\\/g, '/')
        if (tool === 'Read' && /\/memory\/[^/]+\.md$/.test(path)) {
          try {
            memoIndex = String(await $.fs.read(path.replace(/[^/]+$/, 'MEMORY.md')))
          } catch {
            // 목차가 없으면 지침 이름 없이 개수만
          }
        }
        const found = evidenceOf(tool, args, ran.text ?? '', group, memoIndex).map(x => ({ ...x, task }))
        if (found.length > 0) await update($, evidence, list => mergeEvidence(list, found))
        const isBg = args.run_in_background === true && (tool === 'Bash' || tool === 'PowerShell')
        if (isBg || tool === 'Monitor') {
          await update($, bg, list => [...list, { id: call.id, label: call.label, task }].slice(-10))
        }
        if (tool === 'ScheduleWakeup' && args.stop !== true) {
          await update($, bg, list => [...list.filter(b => b.id !== 'wake'), { id: 'wake', label: call.label, task }])
        }
        if (tool === 'ScheduleWakeup' && args.stop === true) {
          await update($, bg, list => list.filter(b => b.id !== 'wake'))
        }
      }

      return ran
    } catch (err) {
      await finish('error')
      throw err
    }
  }).catch(($, e, next) => next(e)) // 관찰 전용: 기록이 실패해도 도구 호출은 그대로

  // 화면: 작업 목록(2개 이상일 때) → 고른 작업의 위(지금 · 진행 · 단계 줄 또는 작업 설명) → 흐름 → 백그라운드 → 근거 → 사용량
  // 글은 자르지 않고 줄을 바꾼다. 색은 상태(초록 성공 · 노랑 진행 · 빨강 실패)에만.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress, Button } = $.ui.resolve(e)
    const ts = await read($, tasks)
    const picked = await read($, focus)
    const all = await read($, calls)
    const allGroups = await read($, groups)
    const allEvidence = await read($, evidence)
    const agents = await read($, subs)
    const bgs = await read($, bg)
    const done = await read($, stories)
    const open = await read($, opened)
    const allNotes = await read($, notes)
    const t = ts.find(x => x.id === picked) ?? ts.at(-1)
    let now = t?.turnAt ?? 0
    try {
      now = await $.clock.now()
    } catch {
      // 시계를 못 읽으면 경과 시간만 멈춘다
    }
    const cols = Math.max(20, (e.props.bodyColumns ?? 40) - 1) // 넓은 글자가 밀리지 않게 한 칸 비움
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 20

    let hud = ''
    try {
      const usage = await $.session.usage()
      const model = prettyModel(await $.session.model())
      const limit = (kind: string, name: string) => {
        const r = usage.rateLimits.find(x => x.kind === kind)
        return r ? `${name} ${Math.round(r.percentUsed)}%` : ''
      }
      hud = [
        model,
        usage.context.percent !== undefined ? `대화 용량 ${usage.context.percent}%` : '',
        limit('five_hour', '5시간 한도'),
        limit('seven_day', '주간 한도'),
      ]
        .filter(Boolean)
        .join(' | ')
    } catch {
      // 사용량을 못 읽으면 그 줄만 뺀다
    }
    const hudBox =
      hud !== '' ? (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {hud}
          </Text>
        </Box>
      ) : null

    if (t === undefined) {
      return (
        <Box flexDirection="column" width={cols}>
          <Text dimColor>아직 작업이 없습니다. 요청을 보내면 여기에 과정이 흐릅니다.</Text>
          {hudBox}
        </Box>
      )
    }

    // 이름표는 흐리게, 내용은 줄바꿈. 들여쓴 줄은 Box 여백으로(넘어간 줄도 같은 자리에서 시작)
    const Row = (label: string, value: string, opts: { bold?: boolean; color?: 'success' | 'error' } = {}) => (
      <Text wrap="wrap">
        <Text dimColor>{label}</Text>{' '}
        <Text bold={opts.bold} color={opts.color}>
          {value}
        </Text>
      </Text>
    )
    const rowLines = (label: string, value: string) => linesOf(`${label} ${value}`, cols)
    const Section = (name: string) => <Text bold>{name}</Text>
    const Indent = (pad: number, child: JSX.Element) => <Box paddingLeft={pad}>{child}</Box>

    const callsOf = (id: number) => all.filter(c => c.task === id && c.agent === undefined)
    const groupsOf = (id: number) => allGroups.filter(g => g.task === id)
    const multi = ts.length > 1
    const activeAgents = agents.filter(s => s.status === 'running')
    // 끝났지만 도우미 · 셸이 아직 뒤에서 도는 작업
    const busy = new Set([...activeAgents.map(s => s.task), ...bgs.map(b => b.task)])

    let used = 0

    // 작업 목록: 「진행 중」(노랑 테두리)과 「끝난 작업」(흐린 테두리) 상자로 나눈다.
    // 번호를 누르면 그 작업을 본다(가장 최근 작업을 누르면 다시 따라감)
    const newestFirst = [...ts].reverse()
    const isActive = (x: Task) => x.status === 'running' || busy.has(x.id)
    const activeTasks = newestFirst.filter(isActive)
    const doneTasks = newestFirst.filter(x => !isActive(x))
    const doneListed = doneTasks.slice(0, Math.max(1, 5 - activeTasks.length))
    const boxInner = cols - 4 // 테두리 2칸 + 안쪽 여백 2칸
    const taskRow = (x: Task) => {
      const sel = x.id === t.id
      const running = x.status === 'running'
      const behind = !running && busy.has(x.id)
      const glyph = running ? '▸' : behind ? '⊷' : x.status === 'answer' ? '✓' : x.status === 'aborted' ? '⊘' : '✗'
      const color = running || behind ? 'warning' : x.status === 'answer' ? 'success' : 'error'
      const meta = running
        ? `${progressOf(x, callsOf(x.id), groupsOf(x.id)).pct}%`
        : behind
          ? '뒤에서 계속'
          : `${DONE_LABEL[x.status]}${x.ms !== undefined ? `, ${duration(x.ms)}` : ''}`
      const request = firstSentence(x.request, 60) || '(이어서 한 작업)'
      used += linesOf(`${glyph} ${request}  ${meta}${sel ? '  보는 중' : ''}`, boxInner - 9)
      return (
        <Box flexDirection="row">
          <Button
            dimColor={!sel}
            key={`task-${x.id}`}
            onPress={async () => {
              await update($, focus, () => (x.id === ts.at(-1)?.id ? 0 : x.id))
            }}
          >
            {`${x.id}번`}
          </Button>
          <Box paddingLeft={1} flexShrink={1}>
            <Text wrap="wrap" bold={sel} dimColor={!sel}>
              <Text color={color}>{glyph}</Text> {request}
              <Text dimColor>{`  ${meta}`}</Text>
              {sel && <Text color={color}>{'  보는 중'}</Text>}
            </Text>
          </Box>
        </Box>
      )
    }
    const taskBox = (name: string, list: Task[], active: boolean, extra?: string) => {
      used += 3 + (extra !== undefined ? 1 : 0) // 테두리 위아래 + 제목
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={active ? 'warning' : undefined}
          borderDimColor={!active}
          paddingX={1}
        >
          <Text bold color={active ? 'warning' : undefined}>{`${name} ${list.length}개`}</Text>
          {list.map(taskRow)}
          {extra !== undefined && <Text dimColor>{extra}</Text>}
        </Box>
      )
    }
    const olderDone = doneTasks.length - doneListed.length
    const taskList = multi ? (
      <Box flexDirection="column" marginBottom={1}>
        {activeTasks.length > 0 && taskBox('진행 중', activeTasks, true)}
        {doneListed.length > 0 &&
          taskBox('끝난 작업', doneListed, false, olderDone > 0 ? `이전 작업 ${olderDone}개` : undefined)}
      </Box>
    ) : null
    used += multi ? 1 : 0

    const mine = callsOf(t.id)
    const gs = groupsOf(t.id)
    const ev = allEvidence.filter(x => x.task === t.id)
    const isRunning = t.status === 'running'
    const story = !isRunning ? done.find(s => s.task === t.id) : undefined
    const { pct, text: pctText, step, seen } = progressOf(t, mine, gs)
    const current = mine.at(-1)?.phase
    const runningCall = [...mine].reverse().find(c => c.status === 'running')
    const lastTouch = Math.max(t.turnAt, ...mine.map(c => c.startedAt + (c.ms ?? 0)))
    const nowText = runningCall
      ? `${runningCall.label} 중  ${duration(now - runningCall.startedAt)}`
      : `다음 할 일 정리 중  ${duration(now - lastTouch)}`

    const phaseRow = (
      <Text>
        {PHASES.map(([p, name]) =>
          isRunning && p === current ? (
            <Text bold color="warning">{`▸${name}  `}</Text>
          ) : seen.has(p) ? (
            <Text color="success">{`✓${name}  `}</Text>
          ) : (
            <Text dimColor>{`◦${name}  `}</Text>
          ),
        )}
      </Text>
    )

    // 훅 한 줄: ⚑ 를 상태 색으로(막음 빨강 · 묻기 · 고침 노랑)
    const taskNotes = allNotes.filter(h => h.task === t.id)
    // ponytail: 인자 이름을 h 로 두면 JSX 의 전역 h 를 가려 화면 전체가 건너뛰어진다
    const HookRow = (note: HookNote, prefix = '') => (
      <Text wrap="wrap">
        <Text bold color={HOOK_COLOR[note.act]}>
          ⚑
        </Text>{' '}
        {note.act === 'load' ? '' : prefix}
        {hookLabel(note)}
      </Text>
    )
    // 근거 한 줄 + 그 아래 흐리게 「왜: 그 단계에서 쓴 이유 문장」
    const ItemRows = (i: Item) => (
      <Box flexDirection="column">
        <Text wrap="wrap">{itemText(i)}</Text>
        {i.why !== undefined &&
          Indent(
            2,
            <Text dimColor wrap="wrap">
              왜: {i.why}
            </Text>,
          )}
      </Box>
    )
    const itemLines = (i: Item, width: number) =>
      linesOf(itemText(i), width) + (i.why !== undefined ? linesOf(`왜: ${i.why}`, width - 2) : 0)

    let head: JSX.Element
    const asks = (t.asks ?? []).slice(-2)
    if (isRunning) {
      // 단계 밖에서 훅이 한 일(요청 · 세션 시작 때 덧붙인 지시)은 위에
      const outer = taskNotes.filter(h => h.group === 0).slice(-3)
      used +=
        rowLines('지금', nowText) +
        3 +
        asks.reduce((n, a) => n + rowLines('추가 요청', a), 0) +
        outer.reduce((n, h) => n + linesOf(`⚑ 훅이 ${hookLabel(h)}`, cols), 0)
      head = (
        <Box flexDirection="column">
          {Row('지금', nowText, { bold: true })}
          {asks.map(a => Row('추가 요청', firstSentence(a)))}
          {outer.map(h => HookRow(h, '훅이 '))}
          <Progress label="진행" value={pct} max={100} valueText={pctText} />
          {phaseRow}
        </Box>
      )
    } else if (story) {
      // 카드: 굵은 제목 아래 한 줄에 하나씩(쉼표로 잇지 않음). 확인한 것은 종류별 개수를 두 칸씩.
      const inner = cols - 2
      const requests = [
        firstSentence(story.request) || '(이어서 한 작업)',
        ...(story.asks ?? []).map(a => `작업 중 추가: ${firstSentence(a)}`),
      ]
      // 쓴 스킬 · 따른 지침 · 판단 근거: 한 줄에 하나 + 「왜:」
      const lists: [string, Item[]][] = (
        [
          ['쓴 스킬', story.skills],
          ['따른 지침', story.guides],
          ['판단 근거', story.basis],
        ] as [string, Item[]][]
      ).filter(([, items]) => items.length > 0)
      const checks: { glyph: string; text: string; color?: 'success' | 'error' }[] = story.unverified
        ? [{ glyph: '✗', text: '바꾼 뒤 검증하지 않았습니다', color: 'error' }]
        : story.checks.length > 0
          ? story.checks.map(c =>
              c.endsWith('실패') ? { glyph: '✗', text: c, color: 'error' } : { glyph: '✓', text: c, color: 'success' },
            )
          : [{ glyph: '◦', text: '검증할 변경 없음' }]
      const half = Math.floor(inner / 2)
      used +=
        3 +
        1 +
        requests.reduce((k, x) => k + linesOf(x, inner), 0) +
        lists.reduce((n, [, items]) => n + 1 + items.reduce((k, x) => k + itemLines(x, inner), 0), 0) +
        (story.hooks.length > 0 ? 1 + story.hooks.reduce((k, h) => k + linesOf(`⚑ ${hookLabel(h)}`, inner), 0) : 0) +
        (story.sources.length > 0 ? 1 + Math.ceil(story.sources.length / 2) : 0) +
        1 +
        checks.length
      head = (
        <Box flexDirection="column">
          <Text>
            <Text bold>{multi ? `${t.id}번 작업 설명` : '작업 설명'}</Text>
            <Text dimColor>
              {'  '}
              {DONE_LABEL[story.status]}
              {story.ms !== undefined ? `, ${duration(story.ms)}` : ''}
            </Text>
          </Text>
          {Section('요청')}
          {Indent(
            2,
            <Box flexDirection="column">
              {requests.map(x => (
                <Text wrap="wrap">{x}</Text>
              ))}
            </Box>,
          )}
          {lists.map(([name, items]) => (
            <Box flexDirection="column">
              {Section(name)}
              {Indent(2, <Box flexDirection="column">{items.map(ItemRows)}</Box>)}
            </Box>
          ))}
          {story.hooks.length > 0 && (
            <Box flexDirection="column">
              {Section('훅 · 규칙')}
              {Indent(2, <Box flexDirection="column">{story.hooks.map(h => HookRow(h))}</Box>)}
            </Box>
          )}
          {story.sources.length > 0 && (
            <Box flexDirection="column">
              {Section('확인한 것')}
              <Box flexDirection="row" flexWrap="wrap" paddingLeft={2}>
                {story.sources.map(x => (
                  <Box width={half}>
                    <Text>{x}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          {Section('검증')}
          {checks.map(c =>
            Indent(
              2,
              <Text wrap="wrap">
                <Text color={c.color} dimColor={c.color === undefined}>
                  {c.glyph}
                </Text>{' '}
                {c.text}
              </Text>,
            ),
          )}
          {phaseRow}
          <Text dimColor>/trace 설명 으로 글로 받기</Text>
        </Box>
      )
    } else {
      used += 1
      head = <Text dimColor>{`${multi ? `${t.id}번 ` : ''}작업은 도구 없이 바로 답했습니다.`}</Text>
    }

    const bgRows = activeAgents.length > 0 || bgs.length > 0 ? 2 + activeAgents.length * 2 + bgs.length : 0
    used += bgRows + (hud !== '' ? 2 : 0)

    // 흐름: 큰 단계([n/m] 문장) 아래에 표시 없는 문장(세부 단계)을 묶는다.
    // 표시가 하나도 없는 작업에선 문장마다 큰 단계.
    const byGroup = (n: number) => mine.filter(c => c.group === n)
    const orphan = byGroup(0)
    const shown: Group[] = [...(orphan.length > 0 ? [{ n: 0, task: t.id, title: NO_TITLE, tools: [] }] : []), ...gs]
    type Major = { lead: Group; subs: Group[]; label: string }
    const majors: Major[] = []
    let marked = false
    for (const g of shown) {
      const prev = majors.at(-1)
      if (g.n !== 0 && !g.step && marked && prev) prev.subs.push(g)
      else {
        if (g.step) marked = true
        majors.push({ lead: g, subs: [], label: g.step ? groupLabel(g) : g.n === 0 ? '' : `(${majors.length + 1})` })
      }
    }
    // 아래 「판단 근거」 칸(작업 중에만): 커밋 · 외부 근거 최근 3개 + 왜.
    // 지침 · 스킬은 흐름에서 그 단계 바로 아래에 보인다.
    const basisNow = [...ev]
      .filter(x => x.kind === 'commit' || x.kind === 'external')
      // 종류 순서대로, 같은 종류 안에선 나중 단계(최근에 찾은 것)부터
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.group - a.group)
      .slice(0, 3)
      .map(x => withWhy(x, gs))
    const basisRows = basisNow.length > 0 ? 2 + basisNow.reduce((n, i) => n + itemLines(i, cols - 2), 0) : 0
    const pending = isRunning && step ? Math.max(0, step.m - step.n) : 0
    let budget = Math.max(4, rows - used - 2 - (pending > 0 ? 1 : 0) - basisRows)
    // 끝나면 작업 설명 카드에 근거가 있으니 아래 칸은 작업 중에만
    const showBasis = isRunning && basisNow.length > 0 && budget >= 4
    if (!showBasis) budget += basisRows

    const blocks: JSX.Element[] = []
    let hidden = 0
    majors
      .slice()
      .reverse()
      .forEach((m, i) => {
        const members = [m.lead, ...m.subs]
        const items = mine.filter(c => members.some(g => g.n === c.group))
        const isNewest = i === 0
        const isLive = isNewest && isRunning
        const isOpen = open.includes(m.lead.n)
        const failed = items.filter(c => c.status === 'error' || c.status === 'denied').length
        const glyph = isLive ? '▸' : '✓'
        const headText = `${glyph} ${m.label ? `${m.label} ` : ''}${m.lead.title}`
        const live = isLive ? items.find(c => c.status === 'running') : undefined
        const latestSub = isLive ? m.subs.at(-1) : undefined
        const doneItems = items.filter(c => c.status !== 'running')
        const summary = [
          countActions(doneItems.map(c => c.src)).join(', '),
          m.subs.length > 0 && !isLive ? `세부 단계 ${m.subs.length}개` : '',
          failed > 0 ? `실패 ${failed}` : '',
        ]
          .filter(Boolean)
          .join(', ')
        // 펼침: 세부 단계 제목 + 동작 하나하나(최근 20줄)
        const detail: JSX.Element[] = []
        if (isOpen) {
          for (const g of members) {
            if (g !== m.lead) detail.push(Indent(4, <Text wrap="wrap">↳ {g.title}</Text>))
            for (const c of byGroup(g.n))
              detail.push(
                Indent(
                  g === m.lead ? 4 : 6,
                  <Text wrap="wrap">
                    <Text color={COLOR[c.status]}>{ICON[c.status]}</Text> {c.label}
                    {c.status === 'error' ? ' 실패' : c.status === 'denied' ? ' 막힘' : ''}
                    {c.target !== undefined && <Text dimColor>{`  ${c.target}`}</Text>}
                  </Text>,
                ),
              )
          }
        }
        const shownDetail = detail.slice(-20)
        // 이 단계에서 따른 지침 · 쓴 스킬 · 훅이 한 일: 접혀 있어도 제목 바로 아래에
        const inStep = (g: number) => members.some(x => x.n === g)
        const stepGuides = ev.filter(x => (x.kind === 'guide' || x.kind === 'skill') && inStep(x.group)).slice(0, 3)
        const stepHooks = taskNotes.filter(h => h.group !== 0 && inStep(h.group)).slice(-2)
        // 펼칠 것이 있을 때만 버튼: 테두리 있는 [ ▾ 펼치기 ] 로 크게
        const hasDetail = items.length > 0 || m.subs.length > 0
        const toggle = isOpen ? '▴ 접기' : '▾ 펼치기'
        const summaryText = isLive && summary !== '' ? `지금까지 ${summary}` : summary
        const need =
          linesOf(headText, cols) +
          stepGuides.reduce((n, x) => n + linesOf(`지침 ${x.text}`, cols - 2), 0) +
          stepHooks.reduce((n, h) => n + linesOf(`⚑ 훅이 ${hookLabel(h)}`, cols - 2), 0) +
          (latestSub ? linesOf(`↳ ${latestSub.title}`, cols - 2) : 0) +
          (live ? linesOf(`⊷ ${live.label} 중 00초`, cols - 2) : 0) +
          (hasDetail || summary !== '' ? linesOf(`[ ${toggle} ] ${summaryText}`, cols - 2) : 0) +
          shownDetail.length
        if (!isNewest && budget - need < 0) {
          hidden += 1
          return
        }
        budget -= need
        blocks.unshift(
          <Box flexDirection="column">
            <Text wrap="wrap" bold={isNewest} dimColor={!isNewest && !isOpen}>
              <Text color={isLive ? 'warning' : 'success'}>{glyph}</Text> {m.label ? `${m.label} ` : ''}
              {m.lead.title}
            </Text>
            {stepGuides.map(x =>
              Indent(
                2,
                <Text wrap="wrap">
                  <Text bold>{x.kind === 'skill' ? '스킬' : '지침'}</Text> {x.text}
                </Text>,
              ),
            )}
            {stepHooks.map(h => Indent(2, HookRow(h, '훅이 ')))}
            {latestSub && Indent(2, <Text wrap="wrap">↳ {latestSub.title}</Text>)}
            {live &&
              Indent(
                2,
                <Text wrap="wrap">
                  <Text color="warning">⊷</Text> {live.label} 중 <Text dimColor>{duration(now - live.startedAt)}</Text>
                </Text>,
              )}
            {(hasDetail || summary !== '') &&
              Indent(
                2,
                <Box flexDirection="row">
                  {hasDetail && (
                    <Button
                      dimColor={!isNewest && !isOpen}
                      key={`step-${m.lead.n}`}
                      onPress={async () => {
                        await update($, opened, list =>
                          list.includes(m.lead.n) ? list.filter(x => x !== m.lead.n) : [...list, m.lead.n],
                        )
                      }}
                    >
                      {toggle}
                    </Button>
                  )}
                  {summary !== '' && (
                    <Box paddingLeft={hasDetail ? 1 : 0} flexShrink={1}>
                      <Text dimColor wrap="wrap">
                        {summaryText}
                      </Text>
                    </Box>
                  )}
                </Box>,
              )}
            {shownDetail}
          </Box>,
        )
      })

    return (
      <Box flexDirection="column" width={cols}>
        {taskList}
        {head}
        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {Section('흐름')}
            {hidden > 0 && Indent(2, <Text dimColor>이전 단계 {hidden}개</Text>)}
            {blocks}
            {pending > 0 && Indent(2, <Text dimColor>◦ 남은 단계 {pending}개</Text>)}
          </Box>
        )}
        {bgRows > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {Section('백그라운드')}
            {activeAgents.map(s => {
              // 도우미마다 따로: 어느 작업에서 띄웠는지 · 동작 수 · 경과 시간 · 최근 동작
              const acts = all.filter(c => c.agent !== undefined && c.agent === s.id)
              const meta = [multi ? `${s.task}번 작업` : '', `동작 ${acts.length}번`, duration(now - s.startedAt)]
                .filter(Boolean)
                .join(', ')
              const latest = acts.at(-1)
              return (
                <Box flexDirection="column">
                  <Text wrap="wrap">
                    <Text color="warning">⊷</Text> {agentName(s.type)}: {s.description}
                    <Text dimColor>{`  ${meta}`}</Text>
                  </Text>
                  {latest && Indent(2, <Text dimColor wrap="wrap">↳ {latest.label}</Text>)}
                </Box>
              )
            })}
            {bgs.map(b => (
              <Text wrap="wrap">
                <Text color="warning">⊷</Text> {b.label}
                {multi && <Text dimColor>{`  ${b.task}번 작업`}</Text>}
              </Text>
            ))}
          </Box>
        )}
        {showBasis && (
          <Box flexDirection="column" marginTop={1}>
            {Section('판단 근거')}
            {basisNow.map(i => Indent(2, ItemRows(i)))}
          </Box>
        )}
        {hudBox}
      </Box>
    )
  })
}
