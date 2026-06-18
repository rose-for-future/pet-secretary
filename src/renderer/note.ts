import type { Task } from '../shared/types'
import type { Api } from '../shared/api'

declare global {
  interface Window {
    api: Api
  }
}

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const mainView = $('main-view')
const detailView = $('detail-view')
const listEl = $<HTMLUListElement>('task-list')
const emptyEl = $('list-empty')

function fmtShort(utcMs: number | null): string {
  if (utcMs == null) return '无时间'
  return new Date(utcMs).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
function fmtFull(utcMs: number | null): string {
  if (utcMs == null) return '无时间'
  return new Date(utcMs).toLocaleString()
}
function statusLabel(s: Task['status']): string {
  return { pending: '待办', done: '已完成', snoozed: '已推迟', expired: '已过期' }[s]
}

async function refresh(): Promise<void> {
  const tasks = await api.listTasks()
  tasks.sort((a, b) => (a.reminderTimeUtc ?? Infinity) - (b.reminderTimeUtc ?? Infinity))
  listEl.innerHTML = ''
  if (tasks.length === 0) {
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  for (const t of tasks) {
    const li = document.createElement('li')
    li.className = 'task-row' + (t.status === 'done' ? ' done' : '')

    const dot = document.createElement('span')
    const fired = t.lastFiredAtUtc != null && t.status === 'pending'
    dot.className = 'dot ' + (fired ? 'fired' : t.status)

    const when = document.createElement('span')
    when.className = 'row-when'
    when.textContent = fmtShort(t.reminderTimeUtc)

    const title = document.createElement('span')
    title.className = 'row-title'
    title.textContent = t.title

    li.append(dot, when, title)
    li.addEventListener('click', () => openDetail(t))
    listEl.append(li)
  }
}

function openDetail(t: Task): void {
  $('d-title').textContent = t.title
  $('d-note').textContent = t.note ? t.note : '（无备注）'
  const fired = t.lastFiredAtUtc != null && t.status === 'pending' ? ' · 已提醒' : ''
  $('d-meta').textContent =
    `提醒时间　${fmtFull(t.reminderTimeUtc)}\n事件时间　${fmtFull(t.eventTimeUtc)}\n状态　　　${statusLabel(t.status)}${fired}`
  $<HTMLButtonElement>('d-complete').onclick = async () => {
    await api.completeTask(t.id)
    closeDetail()
    refresh()
  }
  $<HTMLButtonElement>('d-snooze').onclick = async () => {
    await api.snoozeTask(t.id)
    closeDetail()
    refresh()
  }
  $<HTMLButtonElement>('d-delete').onclick = async () => {
    await api.deleteTask(t.id)
    closeDetail()
    refresh()
  }
  mainView.classList.add('hidden')
  detailView.classList.remove('hidden')
}
function closeDetail(): void {
  detailView.classList.add('hidden')
  mainView.classList.remove('hidden')
}
$<HTMLButtonElement>('d-back').addEventListener('click', closeDetail)

// —— 轻量手动「＋」：标题 + 可选时间，时间解析与语音建提醒共用 ——
const addToggle = $<HTMLButtonElement>('add-toggle')
const quickAdd = $('quick-add')
const qaTitle = $<HTMLInputElement>('qa-title')
const qaWhen = $<HTMLInputElement>('qa-when')

function toggleQuickAdd(show?: boolean): void {
  const willShow = show ?? quickAdd.classList.contains('hidden')
  quickAdd.classList.toggle('hidden', !willShow)
  addToggle.textContent = willShow ? '×' : '＋'
  if (willShow) qaTitle.focus()
  else { qaTitle.value = ''; qaWhen.value = '' }
}
async function submitQuickAdd(): Promise<void> {
  const title = qaTitle.value.trim()
  if (!title) { qaTitle.focus(); return }
  await api.quickAdd({ title, when: qaWhen.value.trim() || undefined })
  toggleQuickAdd(false)
  refresh()
}
addToggle.addEventListener('click', () => toggleQuickAdd())
$<HTMLButtonElement>('qa-submit').addEventListener('click', () => void submitQuickAdd())
for (const el of [qaTitle, qaWhen]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submitQuickAdd()
    else if (e.key === 'Escape') toggleQuickAdd(false)
  })
}

api.onReminder(() => refresh())
api.onNoteRefresh(() => refresh())

refresh()
