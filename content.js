// Patreon Membership Data Exporter Content Script

class PatreonDataExporter {
    constructor() {
        this.baseUrl = 'https://www.patreon.com/api/bills';
        this.pageSize = 100; // Increase for fewer API calls
        this.delay = 200; // Delay between API calls to avoid rate limiting
    }

    // Get currency formatting info using Intl API
    formatCurrency(amountCents, currency) {
        try {
            // Create a formatter to get currency metadata
            const formatter = new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: currency
            });

            // Format a known amount to determine the minor unit factor
            // We'll format 1 unit and see how many decimal places it has
            const parts = formatter.formatToParts(1);
            const fractionPart = parts.find(part => part.type === 'fraction');

            let divisor = 1;
            if (fractionPart) {
                // Count decimal places to determine divisor
                // Most currencies: 2 decimal places = divide by 100
                // Some currencies: 3 decimal places = divide by 1000
                // No decimal places = divide by 1
                divisor = Math.pow(10, fractionPart.value.length);
            }

            const amount = amountCents / divisor;
            return formatter.format(amount);
        } catch (error) {
            console.warn(`Unknown currency ${currency}, treating as minor unit currency`);
            return `${currency} ${(amountCents / 100).toFixed(2)}`;
        }
    }

    // Build API URL with parameters
    buildApiUrl(year, offset = 0) {
        const params = new URLSearchParams({
            'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            'include': 'campaign',
            'fields[campaign]': 'name,url',
            'fields[bill]': 'amount_cents,vat_charge_amount_cents,currency',
            'json-api-use-default-includes': 'false',
            'filter[due_date_year]': year.toString(),
            'page[offset]': offset.toString(),
            'page[count]': this.pageSize.toString(),
            'json-api-version': '1.0'
        });

        return `${this.baseUrl}?${params.toString()}`;
    }

    // Fetch data for a specific year with pagination
    async fetchYearData(year, onProgress) {
        let allBills = [];
        let allCampaigns = new Map();
        let offset = 0;
        let totalPages = 0;
        let currentPage = 0;

        while (true) {
            const url = this.buildApiUrl(year, offset);

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();

                // Extract bills
                const bills = data.data.filter(item => item.type === 'bill');
                allBills.push(...bills);

                // Extract campaigns
                if (data.included) {
                    data.included
                        .filter(item => item.type === 'campaign')
                        .forEach(campaign => {
                            allCampaigns.set(campaign.id, campaign);
                        });
                }

                // Update progress
                if (totalPages === 0 && data.meta && data.meta.count) {
                    totalPages = Math.ceil(data.meta.count / this.pageSize);
                }
                currentPage++;
                onProgress(year, currentPage, totalPages, bills.length);

                // Check if we got a full page
                if (bills.length < this.pageSize) {
                    break;
                }

                offset += this.pageSize;

                // Add delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, this.delay));

            } catch (error) {
                console.error(`Error fetching data for year ${year}, offset ${offset}:`, error);
                throw error;
            }
        }

        return { bills: allBills, campaigns: allCampaigns };
    }

    // Get available years from initial API call
    async getAvailableYears() {
        const url = this.buildApiUrl(new Date().getFullYear(), 0);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return data.meta.years || [];
        } catch (error) {
            console.error('Error fetching available years:', error);
            throw error;
        }
    }

    // Process bills and group by creator and year
    processBillsData(billsByYear, campaignsByYear) {
        const creatorData = new Map();

        for (const [year, { bills, campaigns }] of Object.entries(billsByYear)) {
            for (const bill of bills) {
                const campaignId = bill.relationships?.campaign?.data?.id;
                if (!campaignId) continue;

                const campaign = campaigns.get(campaignId);
                if (!campaign) continue;

                const creatorName = campaign.attributes.name;
                const currency = bill.attributes.currency;
                const amountCents = (bill.attributes.amount_cents || 0) + (bill.attributes.vat_charge_amount_cents || 0);

                if (!creatorData.has(creatorName)) {
                    creatorData.set(creatorName, {
                        name: creatorName,
                        yearlySpends: new Map(),
                        currency: currency, // Store first currency seen for this creator
                        url: campaign.attributes.url // Store campaign URL
                    });
                }

                const creator = creatorData.get(creatorName);
                const currentAmount = creator.yearlySpends.get(year) || 0;
                creator.yearlySpends.set(year, currentAmount + amountCents);
            }
        }

        return creatorData;
    }

    // Generate CSV content
    generateCSV(creatorData, years) {
        // Sort years in descending order
        const sortedYears = [...years].sort((a, b) => b - a);
        const headers = ['Creator', 'Currency', 'URL', 'Total Spend', ...sortedYears.map(year => `Total Spend ${year}`)];

        // Convert to array and calculate total spend for sorting
        const creatorsArray = Array.from(creatorData.values()).map(creator => {
            let totalAmountCents = 0;
            for (const year of years) {
                totalAmountCents += creator.yearlySpends.get(year.toString()) || 0;
            }
            return {
                ...creator,
                totalAmountCents
            };
        });

        // Sort by total spend descending
        creatorsArray.sort((a, b) => b.totalAmountCents - a.totalAmountCents);

        const rows = [headers];

        for (const creator of creatorsArray) {
            const row = [
                creator.name,
                creator.currency,
                creator.url || '',
                this.formatCurrency(creator.totalAmountCents, creator.currency)
            ];

            // Add yearly amounts in descending order
            for (const year of sortedYears) {
                const amountCents = creator.yearlySpends.get(year.toString()) || 0;
                const formattedAmount = this.formatCurrency(amountCents, creator.currency);
                row.push(formattedAmount);
            }

            rows.push(row);
        }

        return rows.map(row => row.join(',')).join('\n');
    }

    // Download CSV file
    downloadCSV(csvContent) {
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');

        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `patreon_membership_data_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    // Update UI with progress
    updateProgress(message, percentage = null) {
        const button = document.getElementById('patreon-export-btn');
        const yearSelect = document.getElementById('patreon-year-select');
        if (button) {
            if (percentage !== null) {
                button.textContent = `${message} (${percentage}%)`;
            } else {
                button.textContent = message;
            }
        }
    }

    // Main export function
    async exportData() {
        const button = document.getElementById('patreon-export-btn');
        const yearSelect = document.getElementById('patreon-year-select');
        if (!button || !yearSelect) return;

        try {
            button.disabled = true;
            yearSelect.disabled = true;
            this.updateProgress('Getting available years...');

            const allYears = await this.getAvailableYears();
            if (allYears.length === 0) {
                throw new Error('No years available');
            }

            // Determine which years to process based on selection
            const selectedValue = yearSelect.value;
            const yearsToProcess = selectedValue === 'all' ? allYears : [parseInt(selectedValue)];

            this.updateProgress('Fetching data...', 0);

            const billsByYear = {};
            const campaignsByYear = {};
            let completedYears = 0;

            for (const year of yearsToProcess) {
                const { bills, campaigns } = await this.fetchYearData(year, (year, currentPage, totalPages, billsCount) => {
                    const pageProgress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;
                    const overallProgress = Math.round(((completedYears / yearsToProcess.length) + (1 / yearsToProcess.length) * (currentPage / Math.max(totalPages, 1))) * 100);
                    this.updateProgress(`Year ${year}: Page ${currentPage}${totalPages > 0 ? `/${totalPages}` : ''} (${billsCount} bills)`, overallProgress);
                });

                billsByYear[year] = { bills, campaigns };
                completedYears++;
            }

            this.updateProgress('Processing data...');
            const creatorData = this.processBillsData(billsByYear, campaignsByYear);

            this.updateProgress('Generating CSV...');
            const csvContent = this.generateCSV(creatorData, yearsToProcess);

            this.updateProgress('Downloading...');
            this.downloadCSV(csvContent);

            this.updateProgress('Complete!');
            setTimeout(() => {
                this.updateProgress('Download Membership Data');
                button.disabled = false;
                yearSelect.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('Export failed:', error);
            this.updateProgress('Export failed - check console');
            button.disabled = false;
            yearSelect.disabled = false;
        }
    }
}

// Initialize the exporter
const exporter = new PatreonDataExporter();

// Create and inject the export button
function createExportButton() {
    // Check if button already exists
    if (document.getElementById('patreon-export-btn')) return;

    // Create container div
    const container = document.createElement('div');
    container.id = 'patreon-export-container';
    container.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 10px;
  `;

    // Create year selector
    const yearSelect = document.createElement('select');
    yearSelect.id = 'patreon-year-select';
    yearSelect.style.cssText = `
    background: white;
    border: 2px solid #ff424d;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 14px;
    color: #333;
    cursor: pointer;
  `;

    // Add default option
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Years';
    yearSelect.appendChild(allOption);

    // Populate years asynchronously
    exporter.getAvailableYears().then(years => {
        // Add years in descending order
        const sortedYears = [...years].sort((a, b) => b - a);
        sortedYears.forEach(year => {
            const option = document.createElement('option');
            option.value = year.toString();
            option.textContent = year.toString();
            yearSelect.appendChild(option);
        });
    }).catch(error => {
        console.warn('Could not load years for selector:', error);
    });

    // Create button
    const button = document.createElement('button');
    button.id = 'patreon-export-btn';
    button.textContent = 'Download Membership Data';
    button.style.cssText = `
    background: #ff424d;
    color: white;
    border: none;
    padding: 12px 20px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: background 0.2s;
  `;

    button.addEventListener('mouseover', () => {
        if (!button.disabled) {
            button.style.background = '#e53e3e';
        }
    });

    button.addEventListener('mouseout', () => {
        if (!button.disabled) {
            button.style.background = '#ff424d';
        }
    });

    button.addEventListener('click', () => {
        exporter.exportData();
    });

    // Add elements to container
    container.appendChild(yearSelect);
    container.appendChild(button);
    document.body.appendChild(container);
}

// Wait for page load and inject button
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createExportButton);
} else {
    createExportButton();
}

// Also inject on navigation (for SPA)
let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        setTimeout(createExportButton, 1000);
    }
}).observe(document, { subtree: true, childList: true });