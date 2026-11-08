import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { getTheme, applyTheme } from './theme';

applyTheme(getTheme());
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getTheme() === 'system') applyTheme('system');
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </React.StrictMode>
);
