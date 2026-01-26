'use client';

import { useTheme } from '@/lib/theme-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Monitor, Sun, Moon } from 'lucide-react';

type ThemePreference = 'auto' | 'light' | 'dark';

const themeOptions: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { value: 'auto', label: 'Auto (System)', icon: <Monitor className="h-4 w-4" /> },
  { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
];

export function AppearanceTab() {
  const { themePreference, setThemePreference } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize how Clawed Abode looks on your device.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="theme-select">Theme</Label>
          <Select value={themePreference} onValueChange={setThemePreference}>
            <SelectTrigger id="theme-select" className="w-full sm:w-[200px]">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              {themeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex items-center gap-2">
                    {option.icon}
                    <span>{option.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {themePreference === 'auto'
              ? 'Automatically switch between light and dark themes based on your system settings.'
              : themePreference === 'light'
                ? 'Always use the light theme.'
                : 'Always use the dark theme.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
