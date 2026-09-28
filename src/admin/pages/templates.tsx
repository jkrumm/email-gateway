import { createElement } from "react";
import { render } from "react-email";
import { emailRegistry, type EmailTemplateEntry } from "../../emails/registry";
import { AdminLayout } from "../layout";
import { EmailFrame, SegmentedLinks } from "../ui";

type RegistryEntry = (typeof emailRegistry)[number];

export function TemplatesListPage() {
  return (
    <AdminLayout title="Templates" active="templates">
      <h1 className="page-title">Templates</h1>
      <p className="page-subtitle" style={{ marginBottom: 16 }}>
        {emailRegistry.length} registered templates
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {emailRegistry.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <a className="row-link" href={`/admin/templates/${entry.id}`}>
                    {entry.name}
                  </a>
                </td>
                <td className="mono">{entry.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}

export function TemplateNotFoundPage({ id }: { id: string }) {
  return (
    <AdminLayout title="Template not found" active="templates">
      <h1 className="page-title">Template not found</h1>
      <p>No template registered with id "{id}".</p>
    </AdminLayout>
  );
}

export async function renderTemplateHtml(
  entry: RegistryEntry,
): Promise<string> {
  // Registry entries are heterogeneous per-template Props; the union type
  // `.find()` returns can't be proven pairwise-consistent to TS, but by
  // construction each entry's component and previewProps always match.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { component, previewProps } = entry as EmailTemplateEntry<any>;
  return render(createElement(component, previewProps));
}

export function TemplateDetailPage({
  entry,
  html,
  width,
}: {
  entry: RegistryEntry;
  html: string;
  width: 600 | 375;
}) {
  return (
    <AdminLayout title={entry.name} active="templates">
      <a className="back-link" href="/admin/templates">
        ← Back
      </a>
      <h1 className="page-title">{entry.name}</h1>
      <p className="page-subtitle mono" style={{ marginBottom: 16 }}>
        {entry.id}
      </p>

      <p style={{ marginBottom: 8 }}>
        <SegmentedLinks
          options={[
            {
              label: "600px",
              href: `/admin/templates/${entry.id}?width=600`,
              active: width === 600,
            },
            {
              label: "375px",
              href: `/admin/templates/${entry.id}?width=375`,
              active: width === 375,
            },
          ]}
        />
      </p>

      <div style={{ maxWidth: width }}>
        <EmailFrame html={html} />
      </div>

      <p className="actions" style={{ marginTop: 12 }}>
        <a href={`/admin/templates/${entry.id}/raw`}>Raw HTML</a>
      </p>
      <details>
        <summary>Preview props</summary>
        <pre>{JSON.stringify(entry.previewProps, null, 2)}</pre>
      </details>
    </AdminLayout>
  );
}
