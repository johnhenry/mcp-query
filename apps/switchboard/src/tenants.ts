export interface Tenant {
  id: string;
  label: string;
  user: string;
  color: string;
}

export const TENANTS: Tenant[] = [
  { id: "acme", label: "Acme Corp", user: "amber@acme.test", color: "#6ea8fe" },
  { id: "globex", label: "Globex", user: "gus@globex.test", color: "#f0883e" },
  { id: "initech", label: "Initech", user: "ines@initech.test", color: "#2dd4bf" },
];
