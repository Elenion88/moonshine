// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root to mount into')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
