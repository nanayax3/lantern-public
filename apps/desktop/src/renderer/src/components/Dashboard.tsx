import { Header, type TopView } from './Header'
import { NotesCard } from './cards/NotesCard'
import { FlameCard } from './cards/FlameCard'
import { SpoonsCard } from './cards/SpoonsCard'
import { LoveBucketCard } from './cards/LoveBucketCard'
import { FeelingCard } from './cards/FeelingCard'
import { ThreadsCard } from './cards/ThreadsCard'
import { PresenceCard } from './cards/PresenceCard'
import { ChatCard } from './cards/ChatCard'
import { PersonalityCard } from './cards/PersonalityCard'

interface Props {
  onOpenConversation: (id: string) => void
  onOpenSettings: () => void
  onNavigate: (view: TopView) => void
  onSeeAllThreads: () => void
}

export function Dashboard({ onOpenConversation, onOpenSettings, onNavigate, onSeeAllThreads }: Props) {
  return (
    <div className="dashboard-shell">
      <div className="ambient-glow" aria-hidden />
      <Header
        currentView="dashboard"
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
      />
      <main className="dashboard">
        <div className="dashboard-left">
          <ChatCard onOpenConversation={onOpenConversation} onSeeAll={onSeeAllThreads} />
          <NotesCard />
          <FeelingCard />
          <PersonalityCard />
          <ThreadsCard />
        </div>
        <div className="dashboard-right">
          <PresenceCard />
          <div className="dashboard-row">
            <FlameCard />
            <SpoonsCard />
          </div>
          <LoveBucketCard />
        </div>
      </main>
      <footer className="dashboard-foot">
        <span>lantern · day one</span>
      </footer>
    </div>
  )
}
