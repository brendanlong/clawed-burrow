'use client';

import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AuthSessionsTab } from '@/components/settings/AuthSessionsTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { RepositoriesTab } from '@/components/settings/RepositoriesTab';

export default function SettingsPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Header />

        <main className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-2xl font-bold mb-6">Settings</h1>

            <Tabs defaultValue="appearance">
              <TabsList className="mb-4">
                <TabsTrigger value="appearance">Appearance</TabsTrigger>
                <TabsTrigger value="repositories">Repositories</TabsTrigger>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
              </TabsList>

              <TabsContent value="appearance">
                <AppearanceTab />
              </TabsContent>

              <TabsContent value="repositories">
                <RepositoriesTab />
              </TabsContent>

              <TabsContent value="sessions">
                <AuthSessionsTab />
              </TabsContent>
            </Tabs>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
