import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import { installAuthInterceptors } from './lib/pairedDevice'

// Install the pairing-token fetch + WebSocket interceptors BEFORE
// React mounts. Fork-registry `device_pairing_auth` — this is the
// only site that patches the global transport for pairing.
installAuthInterceptors()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
