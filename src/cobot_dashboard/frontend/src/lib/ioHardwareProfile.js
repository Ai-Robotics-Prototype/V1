// I/O Hardware Profile — React hooks + public barrel. The pure
// (React-free) logic lives in lib/ioHardwareProfileCore.js so
// node-side doctrine tests can import formatters without pulling
// Zustand + the store dep graph. Keep every public symbol re-
// exported here so callers can continue importing from
// '../lib/ioHardwareProfile'.

import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'

export * from './ioHardwareProfileCore.js'

import { normalizeProfile } from './ioHardwareProfileCore.js'

// Primary profile accessor. Reads from the store slice (which
// hydrates on App mount via hydrateIoHardwareProfile).
export function useIoHardwareProfile() {
  const profile = useStore((s) => s.ioHardwareProfile)
  return normalizeProfile(profile)
}

// Snapshot of the current switch-warning counts, pulled from
// /api/config/io_hardware_profile. The Configure UI uses this to
// render "N tools / M fixtures are set up for Synapse ports" ahead
// of a profile switch so nothing is silently re-mapped.
export function useProfileAssignmentCounts() {
  const [state, setState] = useState({
    loading: true,
    counts: { eoats_with_synapse_ports: 0,
              fixtures_with_synapse_ports: 0 },
  })
  useEffect(() => {
    let alive = true
    fetch('/api/config/io_hardware_profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return
        if (d && d.counts) {
          setState({ loading: false, counts: d.counts })
        } else {
          setState({ loading: false, counts: {
            eoats_with_synapse_ports: 0,
            fixtures_with_synapse_ports: 0 } })
        }
      })
      .catch(() => {
        if (!alive) return
        setState({ loading: false, counts: {
          eoats_with_synapse_ports: 0,
          fixtures_with_synapse_ports: 0 } })
      })
    return () => { alive = false }
  }, [])
  return state
}
