import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

export default function EStopButton() {
  const { robotState, sendCommand, mode } = useStore()
  const estop = robotState?.safety?.estop ?? false

  const [holding, setHolding] = useState(false)
  const [holdProgress, setHoldProgress] = useState(0)
  const holdRef = useRef(null)
  const holdStart = useRef(null)

  const size = mode === 'operator' ? 80 : 56

  function trigger() {
    sendCommand('estop', { active: true })
  }

  function startHold() {
    holdStart.current = performance.now()
    setHolding(true)
    holdRef.current = requestAnimationFrame(function tick() {
      const elapsed = performance.now() - holdStart.current
      const progress = Math.min(elapsed / 2000, 1)
      setHoldProgress(progress)
      if (progress < 1) {
        holdRef.current = requestAnimationFrame(tick)
      } else {
        sendCommand('estop', { active: false })
        setHolding(false)
        setHoldProgress(0)
      }
    })
  }

  function cancelHold() {
    if (holdRef.current) cancelAnimationFrame(holdRef.current)
    setHolding(false)
    setHoldProgress(0)
  }

  useEffect(() => () => { if (holdRef.current) cancelAnimationFrame(holdRef.current) }, [])

  const r = size / 2
  const circumference = 2 * Math.PI * (r - 5)

  return (
    <div style={{ ...styles.wrap, width: size, height: size }}>
      {estop ? (
        // Release mode: hold-to-release
        <div
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          style={{ ...styles.btn, width: size, height: size, background: '#440010', cursor: 'pointer' }}
        >
          <svg width={size} height={size} style={{ position:'absolute', top:0, left:0 }}>
            <circle
              cx={r} cy={r} r={r - 5}
              fill="none" stroke="var(--zone-estop)" strokeWidth={3}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - holdProgress)}
              transform={`rotate(-90 ${r} ${r})`}
            />
          </svg>
          <span style={{ ...styles.label, fontSize: size < 70 ? 9 : 11 }}>
            {holding ? 'HOLD' : 'RELEASE'}
          </span>
        </div>
      ) : (
        // Trigger mode
        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={trigger}
          style={{ ...styles.btn, width: size, height: size }}
          title="Emergency Stop"
        >
          <span style={{ ...styles.label, fontSize: size < 70 ? 10 : 12 }}>E-STOP</span>
        </motion.button>
      )}
    </div>
  )
}

const styles = {
  wrap: {
    position: 'fixed',
    bottom: 24,
    right: 24,
    zIndex: 1000,
  },
  btn: {
    borderRadius: '50%',
    background: 'var(--zone-estop)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    boxShadow: '0 4px 24px rgba(255,0,51,0.4)',
    cursor: 'pointer',
    userSelect: 'none',
  },
  label: {
    fontWeight: 500,
    letterSpacing: '0.08em',
    lineHeight: 1.1,
    textAlign: 'center',
    pointerEvents: 'none',
  },
}
