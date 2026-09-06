import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './diagnostics/AppErrorBoundary.tsx'
import { getBrowserDiagnosticLog } from './diagnostics/diagnostic-log.ts'
import { ProfileProvider } from './settings/ProfileProvider.tsx'

const diagnostics = getBrowserDiagnosticLog()

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary diagnostics={diagnostics}>
    <ProfileProvider>
      <App diagnostics={diagnostics} />
    </ProfileProvider>
  </AppErrorBoundary>,
)
