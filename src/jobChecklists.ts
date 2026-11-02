/** Task checklist per service: the cleaner ticks these on the job and supervisors assess against them. */
const SERVICE_CHECKLISTS: Record<string, string[]> = {
    standard: ['Vacuum all rooms', 'Mop hard floors', 'Clean kitchen surfaces', 'Clean bathrooms', 'Dust surfaces', 'Empty bins', 'Make beds'],
    deep_clean: ['Vacuum and mop all floors', 'Deep clean kitchen (oven, fridge, cupboards)', 'Deep clean bathrooms (grout, limescale)', 'Clean inside windows', 'Dust all surfaces and skirting', 'Clean behind furniture', 'Empty and sanitise bins'],
    end_of_tenancy: ['Full property deep clean', 'Oven and hob deep clean', 'Fridge and freezer clean', 'Bathroom descale and sanitise', 'All windows cleaned inside', 'Carpet vacuum and spot clean', 'Walls and doors wiped', 'Light fixtures cleaned'],
    airbnb: ['Change all bed linens', 'Full bathroom clean', 'Kitchen clean and restock', 'Vacuum and mop floors', 'Dust all surfaces', 'Empty bins and replace liners', 'Check supplies (soap, toilet paper)'],
    commercial: ['Vacuum all areas', 'Mop floors', 'Clean and sanitise kitchenette', 'Clean toilets and washrooms', 'Wipe desks and surfaces', 'Empty all bins', 'Restock supplies'],
    jet_washing: ['Set up equipment', 'Jet wash driveway/patio', 'Clean drainage channels', 'Remove moss and algae', 'Rinse down area', 'Pack up equipment'],
};

export function checklistForService(serviceType: string | null | undefined): string[] {
    const key = String(serviceType || 'standard').trim().replace(/[\s-]+/g, '_').toLowerCase();
    if (key === 'deep') return SERVICE_CHECKLISTS.deep_clean;
    return SERVICE_CHECKLISTS[key] || SERVICE_CHECKLISTS.standard;
}

export type ChecklistItem = { task: string; done: boolean | null };

/** What the cleaner ticked when they finished (newer app versions send it), else the service's tasks. */
export function jobChecklist(serviceType: string | null | undefined, workCompletion: unknown): ChecklistItem[] {
    let wc: any = workCompletion;
    if (typeof wc === 'string') {
        try { wc = JSON.parse(wc); } catch { wc = null; }
    }
    const sent = Array.isArray(wc?.checklist) ? wc.checklist : null;
    if (sent && sent.length) {
        return sent
            .filter((c: any) => c && typeof c.task === 'string' && c.task.trim())
            .slice(0, 40)
            .map((c: any) => ({ task: String(c.task).trim().slice(0, 200), done: Boolean(c.done) }));
    }
    return checklistForService(serviceType).map((task) => ({ task, done: null }));
}
