import { useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { ThreadsView } from './components/ThreadsView'
import { MindView } from './components/MindView'
import { MaintenanceView } from './components/MaintenanceView'
import { ReadingNookView } from './components/ReadingNookView'
import { MovieNookView } from './components/MovieNookView'
import { AlbumView } from './components/AlbumView'
import type { TopView } from './components/Header'

type View = TopView | 'chat' | 'settings'

export function App() {
  const [view, setView] = useState<View>('dashboard')
  const [activeId, setActiveId] = useState<string | null>(null)
  // Remember which top-level view we came from so deep views (chat, settings)
  // know where "back" should return.
  const [returnTo, setReturnTo] = useState<TopView>('dashboard')

  function openConversation(id: string) {
    setActiveId(id)
    setReturnTo(view === 'chats' ? 'chats' : 'dashboard')
    setView('chat')
  }

  function openSettings() {
    setReturnTo(view === 'chats' ? 'chats' : 'dashboard')
    setView('settings')
  }

  function navigateTo(v: TopView) {
    setView(v)
  }

  function back() {
    setView(returnTo)
  }

  if (view === 'chat' && activeId) {
    return <ChatView conversationId={activeId} onBack={back} />
  }

  if (view === 'settings') {
    return <SettingsView onBack={back} />
  }

  if (view === 'chats') {
    return (
      <ThreadsView
        onOpenConversation={openConversation}
        onNavigate={navigateTo}
        onOpenSettings={openSettings}
      />
    )
  }

  if (view === 'mind') {
    return <MindView onNavigate={navigateTo} onOpenSettings={openSettings} />
  }

  if (view === 'maintenance') {
    return <MaintenanceView onNavigate={navigateTo} onOpenSettings={openSettings} />
  }

  if (view === 'nook') {
    return <ReadingNookView onNavigate={navigateTo} onOpenSettings={openSettings} />
  }

  if (view === 'movies') {
    return <MovieNookView onNavigate={navigateTo} onOpenSettings={openSettings} />
  }

  if (view === 'album') {
    return <AlbumView onNavigate={navigateTo} onOpenSettings={openSettings} />
  }

  return (
    <Dashboard
      onOpenConversation={openConversation}
      onOpenSettings={openSettings}
      onNavigate={navigateTo}
      onSeeAllThreads={() => setView('chats')}
    />
  )
}
