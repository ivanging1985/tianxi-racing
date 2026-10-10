# Sync upstream CSV data to Azure SQL

The `upstream_csv_to_azure_sql.yml` workflow runs from your fork, reads the
public `sleepingarhat/tianxi-racing` repository, imports its production CSV data,
and upserts the records into your Azure SQL database. It runs daily at 02:30
Hong Kong time. The first successful run seeds all supported history; later runs
sync the most recent 30 days.

This workflow copies the imported CSV data into Azure SQL; it does not migrate
the existing Cloudflare Workers application or switch that application from D1
to Azure SQL.

## 1. Check your Azure SQL database

- Prefer a dedicated, empty database. The workflow creates the imported tables,
  keys, indexes, and relationships in the `dbo` schema; it does not drop tables.
- Confirm the database's configured maximum size has room for the complete
  import. The local source database built during validation was about 679 MB;
  Azure SQL storage usage will differ and indexes need additional space.
- The server must have **public network access** enabled. The workflow opens
  access only for its current GitHub-hosted runner IP, then removes that
  temporary firewall rule at the end of the job.
- Create a SQL-authenticated database user for the import. It needs permission
  to create tables, indexes, and foreign keys, and insert/update records. For
  the initial setup, a database user in the `db_owner` role is the simplest
  option. Connect to the target database as its administrator and create the
  user, replacing the example username and password:

  ```sql
  CREATE USER [csv_sync] WITH PASSWORD = 'use-a-strong-unique-password';
  ALTER ROLE db_owner ADD MEMBER [csv_sync];
  ```

## 2. Give the workflow permission to manage its temporary firewall rule

Create an Azure service principal and assign it the **Contributor** role scoped
to your individual SQL server resource (not the whole subscription). This
identity is used only by `azure/login` and the Azure CLI firewall-rule
create/delete commands. Store its JSON credentials in the GitHub secret
`AZURE_CREDENTIALS`, using this shape:

```json
{
  "clientId": "application-client-id",
  "clientSecret": "service-principal-secret",
  "subscriptionId": "azure-subscription-id",
  "tenantId": "microsoft-entra-tenant-id"
}
```

In Azure Portal, create an app registration/service principal, then open the
SQL server resource's **Access control (IAM)** and assign **Contributor** to
that service principal. Copy the tenant, client, subscription IDs and create a
client secret for the JSON. Restrict this role assignment to the SQL server
resource so the workflow cannot manage unrelated Azure resources.

## 3. Add GitHub Actions secrets to your fork

In your fork, open **Settings → Secrets and variables → Actions → New repository
secret** and add:

| Secret | Value |
| --- | --- |
| `AZURE_CREDENTIALS` | The JSON service-principal credentials above |
| `AZURE_RESOURCE_GROUP` | Resource group containing your SQL server |
| `AZURE_SQL_SERVER_NAME` | Server name only, without `.database.windows.net` |
| `AZURE_SQL_SERVER` | Full server host, such as `myserver.database.windows.net` |
| `AZURE_SQL_DATABASE` | Your Azure SQL database name |
| `AZURE_SQL_USER` | SQL-authenticated database username |
| `AZURE_SQL_PASSWORD` | Password for that SQL user |

The user/password must be a database user with the permissions described in
step 1. Do not put credentials in the workflow file or commit them to the repo.

## 4. Run the initial seed

Enable GitHub Actions for your fork. Open **Actions → Sync upstream CSVs to
Azure SQL → Run workflow** and start it on the default branch. The initial run
imports the complete supported history and may take several hours. Keep the
workflow run open to monitor progress; a failure is reported in the job log.
The upstream commit marker is written only after all imported data succeeds, so
a failed initial run will try the full seed again on the next run. Imports are
upserts and do not clear existing Azure SQL rows.

After the first successful run, the same workflow syncs daily. Dated race,
form, trackwork, injury, trial, and entry records older than the 30-day correction
window are not replayed; profiles, pedigrees, trainer profiles, jockey season
summaries, and archived source rows are refreshed in full.

## Imported data

- `data/YYYY/`: results, dividends, sectional times, commentary, and video links
- `data/fixtures/`: fixture-calendar rows
- `horses/`: profiles, pedigree, form, trackwork, and injury records
- `jockeys/`: profiles and race-by-race records, plus season summaries
- `trainers/trainer_profiles.csv` and `trainers/records/`
- `trials/`: trial sessions and runners
- `entries/`: upcoming race entries (stored as text files upstream)

CSV rows without a normalized table are retained in `source_csv_rows`.
`backend/test-data/` is intentionally excluded.
