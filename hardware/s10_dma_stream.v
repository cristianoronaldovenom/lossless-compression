// Fixed 128-bit host record to 512-bit AXI-style output.
// Input TKEEP is full and TLAST identifies the end of each 64 KiB block.
// The record also carries a last bit; require both to agree.
// The upstream DMA must preserve record alignment and reset after error.
module s10_dma_stream(
 input wire clk,input wire reset,
 input wire s_valid,output wire s_ready,input wire [127:0] s_data,
 input wire [15:0] s_keep,input wire s_last,
 output wire m_valid,input wire m_ready,output wire [511:0] m_data,
 output wire [63:0] m_keep,output wire m_last,output wire error
);
 wire core_ready,core_error;
 reg frame_error;
 wire bad=(s_keep!=16'hffff)||(s_data[127:92]!=0)||(s_last!=s_data[91]);
 assign error=core_error|frame_error;
 assign s_ready=!error&&core_ready;
 always @(posedge clk) begin
   if(reset)frame_error<=0;
   else if(s_valid&&s_ready&&bad)frame_error<=1;
 end
 s10_binary_stream core(
   .clk(clk),.reset(reset),.in_valid(s_valid&&!error&&!bad),.in_ready(core_ready),
   .in_indices(s_data[63:0]),.symbol0(s_data[73:64]),.symbol1(s_data[83:74]),
   .in_bytes(s_data[90:84]),.in_last(s_data[91]),
   .out_valid(m_valid),.out_ready(m_ready),.out_data(m_data),.out_keep(m_keep),.out_last(m_last),.error(core_error)
 );
endmodule
