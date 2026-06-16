import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Wizard no longer collects workspace bounds — the cell's profile.json
// inherits the backend default; operators tune bounds on the Edit page.
const DEFAULT_DRAFT = () => ({
  cell_id:               null,
  name:                  '',
  baseline_captured:     false,
  baseline_point_count:  0,
  steps_completed:       [],
})

export const useCellWizardStore = create(persist(
  (set, get) => ({
    open:        false,
    pageIdx:     0,
    history:     [0],
    editingId:   null,
    draft:       DEFAULT_DRAFT(),

    // Configure-tab cell-detail panel state (separate from the wizard
    // draft above — the panel edits saved cells in place).
    expandedCellId: null,
    panelDirty:     {},   // { [cellId]: { name?, bounds?, ... } }
    panelSaved:     {},   // last-save timestamps per section, drives green flash

    setExpandedCell: (cellId) => set((s) => ({
      expandedCellId: s.expandedCellId === cellId ? null : cellId,
    })),
    setSectionDirty: (cellId, section, dirty) => set((s) => {
      const cur = s.panelDirty[cellId] || {}
      const next = { ...cur, [section]: !!dirty }
      return { panelDirty: { ...s.panelDirty, [cellId]: next } }
    }),
    markSectionSaved: (cellId, section) => set((s) => {
      const curDirty = s.panelDirty[cellId] || {}
      const nextDirty = { ...curDirty, [section]: false }
      const curSaved = s.panelSaved[cellId] || {}
      const nextSaved = { ...curSaved, [section]: Date.now() }
      return {
        panelDirty: { ...s.panelDirty, [cellId]: nextDirty },
        panelSaved: { ...s.panelSaved, [cellId]: nextSaved },
      }
    }),
    clearCellPanelState: (cellId) => set((s) => {
      const dirty = { ...s.panelDirty }; delete dirty[cellId]
      const saved = { ...s.panelSaved }; delete saved[cellId]
      return {
        panelDirty: dirty,
        panelSaved: saved,
        expandedCellId: s.expandedCellId === cellId ? null : s.expandedCellId,
      }
    }),

    openWizard: (existing) => set({
      open:      true,
      pageIdx:   0,
      history:   [0],
      editingId: existing?.cell_id || null,
      draft: existing ? {
        ...DEFAULT_DRAFT(),
        ...existing,
      } : DEFAULT_DRAFT(),
    }),
    closeWizard: () => set({ open: false }),
    resetWizard: () => set({
      open: false, pageIdx: 0, history: [0],
      editingId: null, draft: DEFAULT_DRAFT(),
    }),

    setField: (key, value) => set((s) => ({ draft: { ...s.draft, [key]: value } })),
    patchDraft: (patch)    => set((s) => ({ draft: { ...s.draft, ...patch } })),

    goNext: () => set((s) => ({
      pageIdx: s.pageIdx + 1,
      history: [...s.history, s.pageIdx + 1],
    })),
    goBack: () => set((s) => {
      if (s.history.length <= 1) return {}
      const h = s.history.slice(0, -1)
      return { pageIdx: h[h.length - 1], history: h }
    }),
    goToPage: (idx) => set({ pageIdx: idx, history: [idx] }),

    markStepComplete: (stepKey) => set((s) => {
      const done = new Set(s.draft.steps_completed || [])
      done.add(stepKey)
      return { draft: { ...s.draft, steps_completed: Array.from(done) } }
    }),
  }),
  {
    name: 'roboai-cell-wizard',
    partialize: (s) => ({
      open: s.open, pageIdx: s.pageIdx, history: s.history,
      editingId: s.editingId, draft: s.draft,
      expandedCellId: s.expandedCellId,
    }),
  },
))
